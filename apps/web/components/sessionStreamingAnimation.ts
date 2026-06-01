export function shouldAnimateStreamingAppend(previousContent: string, nextContent: string) {
  return nextContent.length > previousContent.length && nextContent.startsWith(previousContent);
}
