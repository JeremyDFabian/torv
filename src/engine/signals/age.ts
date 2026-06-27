type Metadata = { exists: boolean; publishedAt?: string; weeklyDownloads?: number } | null;

export async function scoreAge(metadata: Metadata): Promise<number> {
  if (!metadata || !("publishedAt" in metadata) || !metadata.publishedAt) {
    return 0.2;
  }

  const publishedMs = new Date(metadata.publishedAt).getTime();
  if (Number.isNaN(publishedMs)) {
    return 0.2;
  }

  const days = (Date.now() - publishedMs) / (1000 * 60 * 60 * 24);

  if (days < 7) return 0.1;
  if (days < 30) return 0.3;
  if (days < 180) return 0.6;
  return 0.9;
}
