type Metadata = { exists: boolean; publishedAt?: string; weeklyDownloads?: number } | null;

export async function scoreRegistry(metadata: Metadata): Promise<number> {
  if (!metadata || !metadata.exists) {
    return 0;
  }
  return 1;
}
