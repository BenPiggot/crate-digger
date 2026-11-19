export const  text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export const safe = <A>(fn: (args: A) => Promise<string>) => async (args: A) => {
  try {
    return text(await fn(args));
  } catch (e) {
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
  }
};