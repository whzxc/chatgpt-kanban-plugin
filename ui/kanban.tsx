import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CheckCheck,
  Circle,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  SquareKanban,
  Maximize2,
  Minimize2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  X,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorCallout,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingIndicator,
  SingleChoice,
  TooltipProvider,
} from "./components/ui";
import { locale } from "./i18n";
import { initialize, callTool, openLink } from "./bridge";
import "./style.css";
import "./kanban.css";

type Stage = "todo" | "doing" | "review" | "done";
type Link = { agent: string; taskId: string };
type Card = {
  id: string;
  title: string;
  description: string;
  project: string;
  labels: string;
  due: string;
  stage: Stage;
  checklist: { id: string; text: string; done: boolean }[];
  archived: boolean;
  updatedAt?: string;
  link?: Link;
  run?: {
    name: string;
    arguments: { requestId: string; agent: string; prompt: string };
  };
};
type Task = {
  taskId: string;
  title?: string;
  status?: string;
  runtimeStatus?: string;
  activeFlags?: string[];
  desktopUrl?: string;
  lastOutput?: string;
  output?: string;
  turns?: {
    items: { type: string; text?: string; textTruncated?: boolean }[];
  }[];
};
type Board = {
  openUrl?: string;
  cardId?: string;
  revision: number;
  cards: Card[];
  execution?: Task;
  receipt?: {
    state: string;
    error?: { message?: string };
    result?: { error?: { message?: string } };
  };
  executionError?: string;
  discoveryError?: string;
};
const stages: Stage[] = ["todo", "doing", "review", "done"];
const icons = [CircleDashed, Circle, CheckCheck, CircleCheck];
const l = (zh: string, en: string) => (locale.get() === "zh-CN" ? zh : en);
const label = (stage: Stage) =>
  ({
    todo: l("待办", "To do"),
    doing: l("进行中", "In progress"),
    review: l("待验收", "In review"),
    done: l("已完成", "Done"),
  })[stage];
const labels = (value: string) => [
  ...new Set(
    value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const blank = (stage: Stage, project: string): Card => ({
  id: crypto.randomUUID(),
  title: "",
  description: "",
  project,
  labels: "",
  due: "",
  stage,
  checklist: [],
  archived: false,
});
function message(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("KANBAN_CHANGED"))
    return l(
      "看板已更新，本次修改未保存。请载入最新内容或重新打开操作。",
      "Board changed. This change was not saved. Load the latest version or reopen this action.",
    );
  if (text.includes("KANBAN_DIRECTORY_REQUIRED"))
    return l("请填写有效的工作目录。", "Enter a valid working directory.");
  if (text.includes("KANBAN_EXECUTION_PENDING"))
    return l("上次执行仍在提交中。", "The previous request is still pending.");
  return text;
}
const options = () =>
  stages.map((value) => ({
    value,
    label: label(value),
    icon: icons[stages.indexOf(value)],
  }));
export default function Kanban() {
  locale.use();
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [project, setProject] = useState("all");
  const [tag, setTag] = useState("all");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("card") || "",
  );
  const [full, setFull] = useState(false);
  const [edit, setEdit] = useState<{
    card: Card;
    fresh: boolean;
    revision: number;
  }>();
  const [linking, setLinking] = useState<{ revision: number }>();
  const [running, setRunning] = useState<{ card: Card; revision: number }>();
  const [dragged, setDragged] = useState("");
  const [drop, setDrop] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef(board);
  current.current = board;
  const selection = useRef(selected);
  selection.current = selected;
  const serial = useRef(0),
    mutating = useRef(false),
    reading = useRef(false),
    mounted = useRef(true);
  const trigger = useRef<HTMLElement | null>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  const cardButtons = useRef(new Map<string, HTMLButtonElement>());
  const moveFocus = useRef("");
  useEffect(() => {
    if (!moveFocus.current || busy) return;
    cardButtons.current.get(moveFocus.current)?.focus();
    moveFocus.current = "";
  }, [board, busy]);
  const select = (id: string) => {
    if (id) trigger.current = document.activeElement as HTMLElement;
    const url = new URL(location.href);
    url.hash = id ? `card=${encodeURIComponent(id)}` : "";
    history.pushState(null, "", url);
    setSelected(id);
    setFull(false);
    if (!id) requestAnimationFrame(() => trigger.current?.focus());
  };
  const accept = (next: Board) => {
    if (mounted.current) {
      current.current = next;
      setBoard(next);
    }
  };
  const refresh = async (visible = false) => {
    if (mutating.current || reading.current) return;
    reading.current = true;
    const cardId = selection.current;
    const request = ++serial.current;
    if (visible) setBusy(true);
    try {
      await initialize();
      const next = await callTool<Board>(
        "kanban",
        cardId ? { cardId } : {},
      );
      if (
        request === serial.current &&
        mounted.current &&
        cardId === selection.current
      ) {
        accept(next);
        setError("");
      }
    } catch (e) {
      if (request === serial.current && mounted.current) setError(message(e));
    } finally {
      reading.current = false;
      if (request === serial.current && mounted.current) setBusy(false);
      if (mounted.current && cardId !== selection.current) void refresh();
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const tick = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 15000);
    const onBack = () => {
      setSelected(
        new URLSearchParams(location.hash.slice(1)).get("card") || "",
      );
      setFull(false);
    };
    window.addEventListener("popstate", onBack);
    return () => {
      mounted.current = false;
      ++serial.current;
      clearInterval(tick);
      window.removeEventListener("popstate", onBack);
    };
  }, []);
  useEffect(() => {
    void refresh();
    if (selected) closeButton.current?.focus();
  }, [selected]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selected && !edit && !linking && !running)
        select("");
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selected, edit, linking, running]);
  async function mutate(
    args: Record<string, unknown>,
    execute = false,
  ): Promise<boolean> {
    if (!current.current || mutating.current) return false;
    mutating.current = true;
    ++serial.current;
    setBusy(true);
    setError("");
    try {
      const next = await callTool<Board>(
        execute ? "kanban_execute" : "kanban_update",
        { revision: current.current.revision, ...args },
      );
      accept(next);
      if (execute && next.openUrl) await openLink(next.openUrl);
      return true;
    } catch (e) {
      setError(message(e));
      // Reconcile uncertain outcomes without repeating a write or losing the open draft.
      try {
        accept(
          await callTool<Board>(
            "kanban",
            selection.current ? { cardId: selection.current } : {},
          ),
        );
      } catch {
        /* Keep the last visible board. */
      }
      return false;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  const card = board?.cards.find((c) => c.id === selected);
  const projects = [
    ...new Set(board?.cards.map((c) => c.project).filter(Boolean)),
  ].sort();
  const tags = [
    ...new Set(board?.cards.flatMap((c) => labels(c.labels))),
  ].sort();
  const visible =
    board?.cards.filter(
      (c) =>
        c.archived === archived &&
        (project === "all" || c.project === project) &&
        (tag === "all" || labels(c.labels).includes(tag)) &&
        `${c.title} ${c.description} ${c.labels}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ) || [];
  const move = async (id: string, stage: Stage, beforeId = "") => {
    if (id === beforeId || busy) return;
    if (await mutate({ action: "move", id, stage, beforeId }))
      setNotice(l("已移动", "Moved"));
    setDragged("");
    setDrop("");
  };
  const keyboardMove = (e: React.KeyboardEvent, c: Card) => {
    if (!e.altKey || archived || busy) return;
    const moveWithFocus = (stage: Stage, beforeId = "") => {
      moveFocus.current = c.id;
      void move(c.id, stage, beforeId);
    };
    const index = stages.indexOf(c.stage);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      moveWithFocus(
        stages[
          Math.max(0, Math.min(3, index + (e.key === "ArrowLeft" ? -1 : 1)))
        ],
      );
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const rows = visible.filter((v) => v.stage === c.stage),
        i = rows.findIndex((v) => v.id === c.id);
      if (e.key === "ArrowUp" && i > 0) moveWithFocus(c.stage, rows[i - 1].id);
      if (e.key === "ArrowDown" && i < rows.length - 1)
        moveWithFocus(c.stage, rows[i + 2]?.id || "");
    }
  };
  const details = board?.cardId === selected ? board : undefined;
  const task = details?.execution;
  const status = task?.activeFlags?.some((f) =>
    /waiting|approval|input/i.test(f),
  )
    ? l("等待输入", "Needs input")
    : {
        running: l("运行中", "Running"),
        active: l("运行中", "Running"),
        idle: l("空闲", "Idle"),
        completed: l("执行结束", "Finished"),
        failed: l("执行失败", "Failed"),
        cancelled: l("已停止", "Stopped"),
      }[task?.status || task?.runtimeStatus || ""] || l("未知", "Unknown");
  const output =
    task?.lastOutput ||
    task?.output ||
    task?.turns?.[0]?.items
      .filter((i) => i.type === "agentMessage")
      .map((i) => (i.text ? i.text + (i.textTruncated ? "…" : "") : ""))
      .filter(Boolean)
      .join("\n\n");
  const pending =
    !!card?.run &&
    (!details?.receipt ||
      !["completed", "failed", "rejected", "not-executed"].includes(
        details.receipt.state,
      ));
  return (
    <TooltipProvider delayDuration={350}>
      <main
        className={`kanban-app ${selected ? "has-detail" : ""} ${full ? "detail-full" : ""}`}
      >
        <header className="kanban-header">
          <div className="kanban-heading">
            <Icon icon={SquareKanban} size={20} />
            <h1>Kanban</h1>
            <span className="kanban-count">{visible.length}</span>
          </div>
          <div className="kanban-actions">
            <IconButton
              icon={Archive}
              label={
                archived ? l("返回看板", "Back to board") : l("归档", "Archive")
              }
              aria-pressed={archived}
              onClick={() => setArchived(!archived)}
            />
            <IconButton
              icon={RefreshCw}
              label={l("刷新", "Refresh")}
              busy={busy}
              onClick={() => void refresh(true)}
            />
            <Button
              variant="primary"
              disabled={!board || busy}
              onClick={() =>
                setEdit({
                  card: blank("todo", project === "all" ? "" : project),
                  fresh: true,
                  revision: board!.revision,
                })
              }
            >
              <Icon icon={Plus} />
              {l("新建任务", "New task")}
            </Button>
          </div>
        </header>
        <div className="kanban-toolbar">
          <div className="kanban-search">
            <Icon icon={Search} />
            <Input
              aria-label={l("搜索任务", "Search tasks")}
              placeholder={l("搜索任务", "Search tasks")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="kanban-filter">
            <SingleChoice
              label={l("项目", "Project")}
              value={project}
              onChange={setProject}
              options={[
                { value: "all", label: l("全部项目", "All projects") },
                ...projects.map((value) => ({
                  value,
                  label: value.split(/[\\/]/).filter(Boolean).pop() || value,
                })),
              ]}
            />
          </div>
          {tags.length > 0 && (
            <div className="kanban-filter">
              <SingleChoice
                label={l("标签", "Label")}
                value={tag}
                onChange={setTag}
                options={[
                  { value: "all", label: l("全部标签", "All labels") },
                  ...tags.map((value) => ({ value, label: value })),
                ]}
              />
            </div>
          )}
          {(search || project !== "all" || tag !== "all") && (
            <IconButton
              icon={X}
              label={l("清除筛选", "Clear filters")}
              onClick={() => {
                setSearch("");
                setProject("all");
                setTag("all");
              }}
            />
          )}{" "}
          {archived && (
            <span className="kanban-tag">{l("归档", "Archived")}</span>
          )}
        </div>
        {error && (
          <ErrorCallout
            action={
              <Button onClick={() => void refresh(true)}>
                {l("重试", "Retry")}
              </Button>
            }
          >
            {error}
          </ErrorCallout>
        )}
        {board?.discoveryError && <ErrorCallout>{l("本机任务读取失败：", "Could not load local tasks: ")}{board.discoveryError}</ErrorCallout>}
        {!board ? (
          <div className="kanban-loading">
            <LoadingIndicator label={l("加载中", "Loading")} />
          </div>
        ) : (
          <div className="kanban-workspace">
            <div className="kanban-columns">
              {stages.map((stage, index) => (
                <section
                  key={stage}
                  className={`kanban-column ${drop === stage ? "drop-target" : ""}`}
                  aria-label={label(stage)}
                  onDragOver={(e) => {
                    if (dragged && !archived && !busy) {
                      e.preventDefault();
                      setDrop(stage);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragged) void move(dragged, stage);
                  }}
                >
                  <header>
                    <div>
                      <Icon icon={icons[index]} />
                      <h2>{label(stage)}</h2>
                      <span>
                        {visible.filter((c) => c.stage === stage).length}
                      </span>
                    </div>
                    {!archived && (
                      <IconButton
                        size={16}
                        icon={Plus}
                        label={`${l("添加到", "Add to")} ${label(stage)}`}
                        disabled={busy}
                        onClick={() =>
                          setEdit({
                            card: blank(
                              stage,
                              project === "all" ? "" : project,
                            ),
                            fresh: true,
                            revision: board.revision,
                          })
                        }
                      />
                    )}
                  </header>
                  <div className="kanban-cards">
                    {visible
                      .filter((c) => c.stage === stage)
                      .map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          ref={(node) => {
                            if (node) cardButtons.current.set(c.id, node);
                            else cardButtons.current.delete(c.id);
                          }}
                          data-card-id={c.id}
                          className={`kanban-card ${selected === c.id ? "selected" : ""} ${dragged === c.id ? "dragging" : ""} ${drop === c.id ? "drop-before" : ""}`}
                          draggable={!busy && !archived}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", c.id);
                            setDragged(c.id);
                          }}
                          onDragEnd={() => {
                            setDragged("");
                            setDrop("");
                          }}
                          onDragOver={(e) => {
                            if (dragged && !archived && !busy) {
                              e.preventDefault();
                              e.stopPropagation();
                              setDrop(c.id);
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (dragged) void move(dragged, c.stage, c.id);
                          }}
                          onKeyDown={(e) => keyboardMove(e, c)}
                          onClick={() => select(c.id)}
                          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
                        >
                          <strong>{c.title}</strong>
                          {labels(c.labels).length > 0 && (
                            <span className="kanban-tags">
                              {labels(c.labels)
                                .slice(0, 3)
                                .map((t) => (
                                  <span className="kanban-tag" key={t}>
                                    {t}
                                  </span>
                                ))}
                              {labels(c.labels).length > 3 && (
                                <small>+{labels(c.labels).length - 3}</small>
                              )}
                            </span>
                          )}
                          <span className="kanban-card-meta">
                            {c.checklist.length > 0 && (
                              <span>
                                <Icon icon={CheckCheck} />
                                {c.checklist.filter((i) => i.done).length}/
                                {c.checklist.length}
                              </span>
                            )}
                            {c.due && (
                              <span
                                className={
                                  c.stage !== "done" &&
                                  c.due < new Date().toLocaleDateString("sv-SE")
                                    ? "overdue"
                                    : ""
                                }
                              >
                                <Icon icon={CalendarDays} />
                                {c.due.slice(5)}
                              </span>
                            )}
                            {c.link && <span>{c.link.agent}</span>}
                            {c.project && (
                              <small title={c.project}>
                                {c.project.split(/[\\/]/).filter(Boolean).pop()}
                              </small>
                            )}
                          </span>
                        </button>
                      ))}
                    {!visible.some((c) => c.stage === stage) && (
                      <div className="kanban-empty">
                        {l("暂无任务", "No tasks")}
                      </div>
                    )}
                  </div>
                </section>
              ))}
            </div>
            {card && (
              <aside className="kanban-detail" aria-label={card.title}>
                <header>
                  <span>{label(card.stage)}</span>
                  <div className="kanban-actions">
                    <IconButton
                      icon={full ? Minimize2 : Maximize2}
                      label={full ? l("收起", "Collapse") : l("展开", "Expand")}
                      onClick={() => setFull(!full)}
                    />
                    <IconButton
                      ref={closeButton}
                      icon={X}
                      label={l("关闭详情", "Close details")}
                      onClick={() => select("")}
                    />
                  </div>
                </header>
                <div className="kanban-detail-body">
                  <h2>{card.title}</h2>
                  <SingleChoice
                    label={l("阶段", "Stage")}
                    value={card.stage}
                    options={options()}
                    disabled={busy || card.archived}
                    onChange={(stage) => void move(card.id, stage as Stage)}
                  />
                  {card.project && (
                    <div className="kanban-project" title={card.project}>
                      {card.project}
                    </div>
                  )}
                  {card.description && (
                    <p className="kanban-description">{card.description}</p>
                  )}
                  {card.due && (
                    <span className="kanban-card-meta">
                      <Icon icon={CalendarDays} />
                      {card.due}
                    </span>
                  )}
                  <div className="kanban-tags">
                    {labels(card.labels).map((t) => (
                      <span className="kanban-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                  {card.checklist.length > 0 && (
                    <section className="kanban-checklist">
                      <h3>
                        {l("检查清单", "Checklist")}{" "}
                        <small>
                          {card.checklist.filter((i) => i.done).length}/
                          {card.checklist.length}
                        </small>
                      </h3>
                      {card.checklist.map((item, i) => (
                        <Checkbox
                          key={item.id}
                          checked={item.done}
                          disabled={busy || card.archived}
                          onChange={(done) =>
                            void mutate({
                              action: "edit",
                              id: card.id,
                              card: {
                                ...card,
                                checklist: card.checklist.map((v, j) =>
                                  j === i ? { ...v, done } : v,
                                ),
                              },
                            })
                          }
                        >
                          {item.text}
                        </Checkbox>
                      ))}
                    </section>
                  )}
                  <section className="kanban-execution">
                    <div className="kanban-section-heading">
                      <h3>{l("执行", "Execution")}</h3>
                      {card.link && (
                        <span className="kanban-tag">
                          {card.link.agent} ·{" "}
                          {task ? status : l("未读取", "Not loaded")}
                        </span>
                      )}
                    </div>
                    {details?.executionError && (
                      <ErrorCallout>
                        {message(details.executionError)}
                      </ErrorCallout>
                    )}
                    {details?.receipt &&
                      !terminalState(details.receipt.state) && (
                        <span role="status">
                          {details.receipt.state === "unconfirmed"
                            ? l("状态待确认", "Unconfirmed")
                            : details.receipt.state === "awaiting-approval"
                              ? l("等待确认", "Awaiting approval")
                              : l("提交中", "Submitting")}
                        </span>
                      )}
                    {(details?.receipt?.error ||
                      details?.receipt?.result?.error) && (
                      <ErrorCallout>
                        {details.receipt.error?.message ||
                          details.receipt.result?.error?.message ||
                          details.receipt.state}
                      </ErrorCallout>
                    )}
                    {output && <pre className="kanban-output">{output}</pre>}
                    <div className="kanban-actions">
                      {!card.archived && (
                        <Button
                          disabled={busy || pending}
                          onClick={() => {
                            setError("");
                            setLinking({ revision: board.revision });
                          }}
                        >
                          {card.link || card.run
                            ? l("更换关联", "Change linked task")
                            : l("关联任务", "Link task")}
                        </Button>
                      )}
                      {!card.archived && (card.link || card.run) && (
                        <Button
                          disabled={busy || pending}
                          onClick={async () => {
                            if (
                              await mutate({
                                action: "link",
                                id: card.id,
                                link: null,
                              })
                            )
                              void refresh();
                          }}
                        >
                          {l("解除关联", "Unlink task")}
                        </Button>
                      )}
                      {task?.desktopUrl && (
                        <Button
                          onClick={() =>
                            void openLink(task.desktopUrl!).catch((e) =>
                              setError(message(e)),
                            )
                          }
                        >
                          <Icon icon={ExternalLink} />
                          {l("打开对话", "Open chat")}
                        </Button>
                      )}
                      {!card.archived && (
                        <Button
                          variant="primary"
                          disabled={busy || (!!card.run && !details)}
                          onClick={() =>
                            pending && card.run
                              ? void mutate(
                                  {
                                    id: card.id,
                                    requestId: card.run.arguments.requestId,
                                  },
                                  true,
                                )
                              : (setError(""),
                                setRunning({ card, revision: board.revision }))
                          }
                        >
                          <Icon icon={Play} />
                          {card.run && !details
                            ? l("加载中", "Loading")
                            : pending
                              ? l("重试提交", "Retry request")
                              : card.link
                                ? l("继续执行", "Continue")
                                : l("开始执行", "Run")}
                        </Button>
                      )}
                    </div>
                  </section>
                  {(card.link || card.run) && (
                    <p className="kanban-hint">
                      {pending
                        ? l(
                            "提交状态确认前不能更换或解除关联。",
                            "Wait for the request to be confirmed before changing or removing the link.",
                          )
                        : l(
                            "更换或解除关联不会中断原任务。",
                            "Changing or removing the link does not interrupt the original task.",
                          )}
                    </p>
                  )}
                </div>
                <footer>
                  <Button
                    disabled={busy || card.archived}
                    onClick={() => {
                      setError("");
                      setEdit({ card, fresh: false, revision: board.revision });
                    }}
                  >
                    <Icon icon={Pencil} />
                    {l("编辑", "Edit")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await mutate({
                          action: "archive",
                          id: card.id,
                          archived: !card.archived,
                        })
                      )
                        select("");
                    }}
                  >
                    <Icon icon={card.archived ? Undo2 : Archive} />
                    {card.archived
                      ? l("恢复", "Restore")
                      : l("归档", "Archive")}
                  </Button>
                </footer>
              </aside>
            )}
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {notice}
        </span>
        {edit && (
          <Editor
            key={`${edit.card.id}:${edit.revision}`}
            card={edit.card}
            fresh={edit.fresh}
            busy={busy}
            error={error}
            close={() => setEdit(undefined)}
            changed={!edit.fresh && edit.revision !== board?.revision}
            reload={() => {
              const latest = current.current?.cards.find(
                (c) => c.id === edit.card.id,
              );
              if (latest && current.current) {
                setError("");
                setEdit({
                  card: latest,
                  fresh: false,
                  revision: current.current.revision,
                });
              }
            }}
            save={async (card) => {
              if (
                await mutate({
                  action: edit.fresh ? "create" : "edit",
                  id: card.id,
                  card,
                  ...(!edit.fresh ? { revision: edit.revision } : {}),
                })
              ) {
                setEdit(undefined);
                select(card.id);
              }
            }}
          />
        )}
        {linking && card && (
          <LinkTask
            error={error}
            busy={busy}
            close={() => setLinking(undefined)}
            save={async (link) => {
              if (
                await mutate({
                  action: "link",
                  id: card.id,
                  link,
                  revision: linking.revision,
                })
              ) {
                setLinking(undefined);
                void refresh();
              }
            }}
          />
        )}
        {running && card && (
          <RunTask
            card={running.card}
            run={card.run}
            busy={busy}
            error={error}
            close={() => setRunning(undefined)}
            save={async (agent, prompt, requestId, project) => {
              if (
                await mutate(
                  {
                    id: card.id,
                    agent,
                    prompt,
                    requestId,
                    project,
                    revision: running.revision,
                  },
                  true,
                )
              )
                setRunning(undefined);
            }}
          />
        )}
      </main>
    </TooltipProvider>
  );
}
function terminalState(state: string) {
  return ["completed", "failed", "rejected", "not-executed"].includes(state);
}
function Editor({
  card,
  fresh,
  busy,
  error,
  close,
  save,
  changed,
  reload,
}: {
  card: Card;
  fresh: boolean;
  busy: boolean;
  error: string;
  close: () => void;
  save: (card: Card) => Promise<void>;
  changed: boolean;
  reload: () => void;
}) {
  const [titleError, setTitleError] = useState("");
  const [draft, setDraft] = useState(card);
  const [checkError, setCheckError] = useState("");
  const update = (key: keyof Card, value: string) =>
    setDraft({ ...draft, [key]: value });
  const reorder = (index: number, offset: number) => {
    const checklist = [...draft.checklist];
    const [item] = checklist.splice(index, 1);
    checklist.splice(index + offset, 0, item);
    setDraft({ ...draft, checklist });
    requestAnimationFrame(() =>
      document.getElementById(`kb-item-${item.id}`)?.focus(),
    );
  };
  return (
    <Dialog
      title={fresh ? l("新建任务", "New task") : l("编辑任务", "Edit task")}
      onClose={close}
      busy={busy}
      width={640}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {l("取消", "Cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="kanban-editor"
            busy={busy}
          >
            {l("保存", "Save")}
          </Button>
        </>
      }
    >
      <form
        id="kanban-editor"
        className="kanban-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.title.trim()) {
            setTitleError(l("请输入标题", "Enter a title"));
            document.getElementById("kb-title")?.focus();
            return;
          }
          const empty = draft.checklist.find((item) => !item.text.trim());
          if (empty) {
            setCheckError(empty.id);
            document.getElementById(`kb-item-${empty.id}`)?.focus();
            return;
          }
          void save({
            ...draft,
            title: draft.title.trim(),
            checklist: draft.checklist.map((item) => ({
              ...item,
              text: item.text.trim(),
            })),
          });
        }}
      >
        <Field id="kb-title" label={l("标题", "Title")} error={titleError}>
          <Input
            id="kb-title"
            aria-invalid={!!titleError}
            aria-describedby={titleError ? "kb-title-error" : undefined}
            autoFocus
            required
            maxLength={240}
            value={draft.title}
            onChange={(e) => {
              setTitleError("");
              update("title", e.target.value);
            }}
          />
        </Field>
        <Field id="kb-description" label={l("描述", "Description")}>
          <textarea
            className="input"
            id="kb-description"
            rows={5}
            maxLength={20000}
            value={draft.description}
            onChange={(e) => update("description", e.target.value)}
          />
        </Field>
        <Field label={l("阶段", "Stage")}>
          <SingleChoice
            label={l("阶段", "Stage")}
            value={draft.stage}
            options={options()}
            onChange={(value) => update("stage", value)}
          />
        </Field>
        <Field id="kb-project" label={l("工作目录", "Working directory")}>
          <Input
            id="kb-project"
            maxLength={2000}
            value={draft.project}
            onChange={(e) => update("project", e.target.value)}
          />
        </Field>
        <div className="kanban-form-row">
          <Field id="kb-labels" label={l("标签", "Labels")}>
            <Input
              id="kb-labels"
              maxLength={500}
              placeholder={l("标签，以逗号分隔", "Comma-separated labels")}
              value={draft.labels}
              onChange={(e) => update("labels", e.target.value)}
            />
          </Field>
          <Field id="kb-due" label={l("截止日期", "Due date")}>
            <Input
              type="date"
              id="kb-due"
              value={draft.due}
              onChange={(e) => update("due", e.target.value)}
            />
          </Field>
        </div>
        <Field label={l("检查清单", "Checklist")}>
          <div className="kanban-checklist-editor">
            {draft.checklist.map((item, index) => (
              <Field
                key={item.id}
                id={`kb-item-${item.id}`}
                label={`${l("检查项", "Item")} ${index + 1}`}
                error={
                  checkError === item.id
                    ? l("请输入检查项内容", "Enter an item description")
                    : undefined
                }
              >
                <div className="kanban-checklist-row">
                  <Checkbox
                    checked={item.done}
                    disabled={busy}
                    onChange={(done) =>
                      setDraft({
                        ...draft,
                        checklist: draft.checklist.map((v) =>
                          v.id === item.id ? { ...v, done } : v,
                        ),
                      })
                    }
                  >
                    <span className="sr-only">{`${l("完成检查项", "Complete item")} ${index + 1}`}</span>
                  </Checkbox>
                  <Input
                    id={`kb-item-${item.id}`}
                    value={item.text}
                    maxLength={500}
                    disabled={busy}
                    aria-invalid={checkError === item.id}
                    aria-describedby={
                      checkError === item.id
                        ? `kb-item-${item.id}-error`
                        : undefined
                    }
                    onChange={(e) => {
                      setCheckError("");
                      setDraft({
                        ...draft,
                        checklist: draft.checklist.map((v) =>
                          v.id === item.id ? { ...v, text: e.target.value } : v,
                        ),
                      });
                    }}
                  />
                  <div className="kanban-actions">
                    <IconButton
                      icon={ArrowUp}
                      label={`${l("上移检查项", "Move item up")} ${index + 1}`}
                      disabled={busy || index === 0}
                      onClick={() => reorder(index, -1)}
                    />
                    <IconButton
                      icon={ArrowDown}
                      label={`${l("下移检查项", "Move item down")} ${index + 1}`}
                      disabled={busy || index === draft.checklist.length - 1}
                      onClick={() => reorder(index, 1)}
                    />
                    <IconButton
                      icon={X}
                      label={`${l("移除检查项", "Remove item")} ${index + 1}`}
                      disabled={busy}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          checklist: draft.checklist.filter(
                            (v) => v.id !== item.id,
                          ),
                        });
                        const next =
                          draft.checklist[index + 1] ||
                          draft.checklist[index - 1];
                        requestAnimationFrame(() =>
                          document
                            .getElementById(
                              next ? `kb-item-${next.id}` : "kb-add-item",
                            )
                            ?.focus(),
                        );
                      }}
                    />
                  </div>
                </div>
              </Field>
            ))}
            <Button
              id="kb-add-item"
              disabled={busy || draft.checklist.length >= 100}
              onClick={() => {
                const id = crypto.randomUUID();
                setDraft({
                  ...draft,
                  checklist: [
                    ...draft.checklist,
                    { id, text: "", done: false },
                  ],
                });
                requestAnimationFrame(() =>
                  document.getElementById(`kb-item-${id}`)?.focus(),
                );
              }}
            >
              <Icon icon={Plus} />
              {l("添加检查项", "Add item")}
            </Button>
          </div>
        </Field>
        {changed && (
          <ErrorCallout
            action={
              <Button disabled={busy} onClick={reload}>
                {l("放弃草稿，载入最新", "Discard draft and load latest")}
              </Button>
            }
          >
            {l(
              "看板已更新。当前草稿仍保留，保存不会覆盖其他修改。",
              "The board has changed. Your draft is preserved; saving will not overwrite other changes.",
            )}
          </ErrorCallout>
        )}
        {error && <ErrorCallout>{error}</ErrorCallout>}
      </form>
    </Dialog>
  );
}
function useAgents() {
  const [agents, setAgents] = useState<{ value: string; label: string }[]>([
    { value: "codex", label: "Codex" },
  ]);
  useEffect(() => {
    let active = true;
    void callTool<{
      agents: {
        agent: string;
        displayName?: string;
        installed?: boolean;
        enabled?: boolean;
      }[];
    }>("agents", {})
      .then((data) => {
        if (active && data.agents?.length)
          setAgents(
            data.agents
              .filter((a) => a.enabled !== false && a.installed !== false)
              .map((a) => ({
                value: a.agent,
                label: a.displayName || a.agent,
              })),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return agents;
}
function LinkTask({
  error: mutationError,
  busy,
  close,
  save,
}: {
  busy: boolean;
  close: () => void;
  save: (link: Link) => Promise<void>;
  error: string;
}) {
  const agents = useAgents(),
    [agent, setAgent] = useState("codex"),
    [tasks, setTasks] = useState<Task[]>([]),
    [next, setNext] = useState<{ cursor?: string; offset?: number }>(),
    [search, setSearch] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setTasks([]);
    setNext(undefined);
    void callTool<{ tasks: Task[]; nextCursor?: string; nextOffset?: number }>(
      "agent_tasks",
      { agent, limit: 200 },
    )
      .then((data) => {
        if (active) {
          setTasks(data.tasks || []);
          setNext(
            data.nextCursor
              ? { cursor: data.nextCursor }
              : data.nextOffset != null
                ? { offset: data.nextOffset }
                : undefined,
          );
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agent]);
  return (
    <Dialog
      title={l("关联任务", "Link task")}
      onClose={close}
      busy={busy}
      width={600}
    >
      <div className="kanban-form">
        <SingleChoice
          label="Agent"
          value={agent}
          options={agents}
          disabled={loading || busy}
          onChange={setAgent}
        />
        <Input
          aria-label={l("搜索任务", "Search tasks")}
          placeholder={l("搜索任务", "Search tasks")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {error && <ErrorCallout>{error}</ErrorCallout>}
        {mutationError && <ErrorCallout>{mutationError}</ErrorCallout>}
        {loading && <LoadingIndicator label={l("加载中", "Loading")} />}
        {!loading && !tasks.length && <span>{l("暂无任务", "No tasks")}</span>}
        <div className="kanban-task-list">
          {tasks
            .filter((t) =>
              `${t.title} ${t.taskId}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((task) => (
              <Button
                key={task.taskId}
                disabled={busy}
                onClick={() => void save({ agent, taskId: task.taskId })}
              >
                {task.title || task.taskId}
                <Icon icon={ArrowRight} />
              </Button>
            ))}
        </div>
        {next && (
          <Button
            disabled={loading || busy}
            onClick={async () => {
              setLoading(true);
              setError("");
              try {
                const data = await callTool<{
                  tasks: Task[];
                  nextCursor?: string;
                  nextOffset?: number;
                }>("agent_tasks", { agent, limit: 200, ...next });
                setTasks((current) => [
                  ...current,
                  ...(data.tasks || []).filter(
                    (t) => !current.some((c) => c.taskId === t.taskId),
                  ),
                ]);
                setNext(
                  data.nextCursor
                    ? { cursor: data.nextCursor }
                    : data.nextOffset != null
                      ? { offset: data.nextOffset }
                      : undefined,
                );
              } catch (e) {
                setError(message(e));
              } finally {
                setLoading(false);
              }
            }}
          >
            {l("加载更多", "Load more")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
function RunTask({
  card,
  run,
  busy,
  error,
  close,
  save,
}: {
  card: Card;
  run: Card["run"];
  busy: boolean;
  error: string;
  close: () => void;
  save: (
    agent: string,
    prompt: string,
    requestId: string,
    project: string,
  ) => Promise<void>;
}) {
  const [project, setProject] = useState(card.project);
  const [projectError, setProjectError] = useState("");
  const [promptError, setPromptError] = useState("");
  const directoryError =
    projectError ||
    (error === message("KANBAN_DIRECTORY_REQUIRED") ? error : "");
  useEffect(() => {
    if (directoryError) document.getElementById("kb-run-project")?.focus();
  }, [directoryError]);
  const agents = useAgents(),
    [agent, setAgent] = useState(card.link?.agent || "codex"),
    [prompt, setPrompt] = useState(
      card.link
        ? ""
        : `${card.title}\n\n${card.description}${card.checklist.length ? "\n\n" + card.checklist.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n") : ""}`.trim(),
    ),
    [requestId] = useState(() => crypto.randomUUID());
  const persisted = run?.arguments.requestId === requestId;
  return (
    <Dialog
      title={card.link ? l("继续执行", "Continue") : l("开始执行", "Run task")}
      busy={busy}
      onClose={close}
      width={600}
      footer={
        <>
          <Button disabled={busy} onClick={close}>
            {l("取消", "Cancel")}
          </Button>
          <Button form="kb-run" type="submit" variant="primary" busy={busy}>
            {persisted ? l("重试提交", "Retry request") : l("发送", "Send")}
          </Button>
        </>
      }
    >
      <form
        id="kb-run"
        className="kanban-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!card.link && !project.trim()) {
            setProjectError(
              l("请填写有效的工作目录。", "Enter a valid working directory."),
            );
            document.getElementById("kb-run-project")?.focus();
            return;
          }
          if (!prompt.trim()) {
            setPromptError(l("请输入指令", "Enter a prompt"));
            document.getElementById("kb-prompt")?.focus();
            return;
          }
          void save(agent, prompt, requestId, project.trim());
        }}
      >
        <Field label="Agent">
          <SingleChoice
            label="Agent"
            value={agent}
            options={agents}
            onChange={setAgent}
            disabled={!!card.link || persisted || busy}
          />
        </Field>
        {!card.link && (
          <Field
            id="kb-run-project"
            label={l("工作目录", "Working directory")}
            error={directoryError}
          >
            <Input
              id="kb-run-project"
              value={project}
              required
              maxLength={2000}
              readOnly={persisted || busy}
              autoFocus={!project.trim()}
              aria-invalid={!!directoryError}
              aria-describedby={
                directoryError
                  ? "kb-run-project-error kb-run-project-help"
                  : "kb-run-project-help"
              }
              onChange={(e) => {
                setProjectError("");
                setProject(e.target.value);
              }}
            />
            <p id="kb-run-project-help" className="kanban-hint">
              {l(
                "填写运行插件的设备上的绝对路径。提交时会检查目录，并保存到卡片。",
                "Enter an absolute path on the plugin device. The directory is checked when submitting and saved to this card.",
              )}
            </p>
          </Field>
        )}
        <Field id="kb-prompt" label={l("指令", "Prompt")} error={promptError}>
          <textarea
            className="input"
            id="kb-prompt"
            readOnly={persisted || busy}
            required
            autoFocus={!!card.link || !!project.trim()}
            rows={8}
            maxLength={24000}
            value={prompt}
            aria-invalid={!!promptError}
            aria-describedby={promptError ? "kb-prompt-error" : undefined}
            onChange={(e) => {
              setPromptError("");
              setPrompt(e.target.value);
            }}
          />
        </Field>
        {error && error !== directoryError && (
          <ErrorCallout>{error}</ErrorCallout>
        )}
      </form>
    </Dialog>
  );
}
