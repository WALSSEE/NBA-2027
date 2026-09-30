// Supabase palauttaa oletuksena enintään 1000 riviä per haku — haetaan sivuittain kaikki.
export async function fetchAll<T = any>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<{ data: T[]; error: any }> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { data: out, error: null };
}
