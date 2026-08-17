type FloodIdentityInput = {
  title: string;
  country?: string;
  occurredAt: string;
};

export function floodProcessEntityKey(event: FloodIdentityInput) {
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(+occurredAt)) return null;
  const year = occurredAt.getUTCFullYear();
  if (/太湖.*洪水/u.test(event.title)) {
    const episode = event.title.match(/第\s*(\d+)\s*号洪水/u)?.[1];
    return `flood:${year}:taihu:${episode ? Number(episode) : `bulletin-${Math.floor(+occurredAt / (14 * 86_400_000))}`}`;
  }
  const numbered = event.title.match(/(.{0,20}?)(\d{4})年第\s*(\d+)\s*号洪水/u);
  if (numbered) return `flood:${numbered[2]}:${normalizeFloodRegion(numbered[1] || event.country || "region")}:${Number(numbered[3])}`;
  const warningTarget = event.title.match(/([^，。；]{2,30}?)洪水(?:红色|橙色|黄色|蓝色)?预警/u);
  if (warningTarget) return `flood:${year}:${normalizeProcessText(warningTarget[1])}:bulletin-${Math.floor(+occurredAt / (14 * 86_400_000))}`;
  return null;
}

export function sameFloodRegion(a: string, b: string) {
  const floodA = a.match(/^flood:(\d{4}):([^:]+):/);
  const floodB = b.match(/^flood:(\d{4}):([^:]+):/);
  return Boolean(floodA && floodB && floodA[1] === floodB[1] && floodA[2] === floodB[2]);
}

function normalizeFloodRegion(value: string) {
  return normalizeProcessText(value.replace(/(?:流域)?(?:发生|出现|遭遇)$/u, "")) || "region";
}

function normalizeProcessText(value: string) {
  return value.toLowerCase().normalize("NFKC").replace(/[“”‘’"'`]/g, "").replace(/[\s·_—–-]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/^-|-$/g, "").slice(0, 80);
}
