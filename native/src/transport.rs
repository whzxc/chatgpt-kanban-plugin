//! Private loopback transport; no browser or remote ingress.
use crate::*;
use std::time::Duration;
use tokio::net::TcpListener;
pub async fn listen(owner: Arc<service::Service>) -> Result<tokio::task::JoinHandle<()>> {
    use http_body_util::{BodyExt, Full, Limited};
    use hyper::{body::Bytes, server::conn::http1, service::service_fn, Request, Response};
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let build = runtime::build_id(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let info = json!({"port":port,"pid":std::process::id(),"token":owner.token,"instance":owner.control.session,"version":env!("CARGO_PKG_VERSION"),"owner":"kanban","build":build});
    save(&root().join("web/native.json"), &info)?;
    Ok(tokio::spawn(async move {
        while let Ok((stream, peer)) = listener.accept().await {
            if !peer.ip().is_loopback() {
                continue;
            }
            let (owner, info) = (owner.clone(), info.clone());
            tokio::spawn(async move {
                let handler = service_fn(move |request: Request<hyper::body::Incoming>| {
                    let (owner, info) = (owner.clone(), info.clone());
                    async move {
                        let result: Result<Value> = async {
                            if request.headers().get("host").and_then(|v| v.to_str().ok())
                                != Some(format!("127.0.0.1:{port}").as_str())
                                || request
                                    .headers()
                                    .get("authorization")
                                    .and_then(|v| v.to_str().ok())
                                    != Some(format!("Bearer {}", owner.token).as_str())
                                || request.headers().contains_key("origin")
                            {
                                return Err("unauthorized".into());
                            }
                            let method = request.method().clone();
                            let path = request.uri().path().to_owned();
                            if method == hyper::Method::GET && path == "/healthz" {
                                let mut health = info.clone();
                                health.as_object_mut().unwrap().remove("token");
                                return Ok(health);
                            }
                            if method != hyper::Method::POST {
                                return Err("UNKNOWN_ROUTE".into());
                            }
                            let bytes = Limited::new(request.into_body(), 65536)
                                .collect()
                                .await
                                .map_err(|e| e.to_string())?
                                .to_bytes();
                            let body = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                            owner
                                .request(path.strip_prefix("/api/").ok_or("UNKNOWN_ROUTE")?, body)
                                .await
                        }
                        .await;
                        let (status, body) = match result {
                            Ok(v) => (200, v),
                            Err(error) => (400, json!({"error":error})),
                        };
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .status(status)
                                .header("Content-Type", "application/json")
                                .header("Cache-Control", "no-store")
                                .body(Full::new(Bytes::from(body.to_string())))
                                .unwrap(),
                        )
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), handler)
                    .await;
            });
        }
    }))
}
pub async fn forward_request(route: &str, method: &str, body: Value) -> Result<Value> {
    crate::init_crypto();
    let unavailable = "无法连接看板运行时，请重新加载插件。";
    let info = load(&root().join("web/native.json")).map_err(|_| unavailable)?;
    let port = info["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or(unavailable)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let health: Value = client
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .bearer_auth(string(&info, "token"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map_err(|_| unavailable)?
        .error_for_status()
        .map_err(|_| unavailable)?
        .json()
        .await
        .map_err(|_| unavailable)?;
    if health["instance"] != info["instance"] {
        return Err(unavailable.into());
    }
    forward_to(&info, route, method, body).await
}
pub async fn forward_to(info: &Value, route: &str, method: &str, body: Value) -> Result<Value> {
    let port = info["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("invalid local endpoint")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut request = client
        .request(
            method.clone(),
            format!("http://127.0.0.1:{port}/api/{route}"),
        )
        .bearer_auth(string(&info, "token"))
        .timeout(Duration::from_secs(
            if route == "plugin/call"
                || route == "start"
                || route.ends_with("/start")
                || route.ends_with("/start-all")
            {
                360
            } else {
                120
            },
        ));
    if method != reqwest::Method::GET {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let success = response.status().is_success();
    let value: Value = response.json().await.map_err(|e| e.to_string())?;
    if success {
        Ok(value)
    } else {
        Err(string(&value, "error").into())
    }
}
