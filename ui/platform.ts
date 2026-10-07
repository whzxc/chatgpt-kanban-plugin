export async function copyText(value: string) { await navigator.clipboard.writeText(value); }
export async function openUrl(url: string) {
  const { openLink } = await import('./bridge');
  await openLink(url);
}
