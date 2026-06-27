type Metadata = { exists: boolean; publishedAt?: string } | null;

export async function scoreAdoption(metadata: Metadata, name: string): Promise<number> {
  if (!metadata || !metadata.exists) {
    return 0.3;
  }

  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
    if (!res.ok) return 0.3;

    const data = await res.json() as { downloads?: number };
    const w = data.downloads;
    if (w === undefined || w === null) return 0.3;

    if (w < 10) return 0.2;
    if (w < 100) return 0.4;
    if (w < 1000) return 0.6;
    if (w < 10_000) return 0.8;
    return 0.95;
  } catch {
    return 0.3;
  }
}
