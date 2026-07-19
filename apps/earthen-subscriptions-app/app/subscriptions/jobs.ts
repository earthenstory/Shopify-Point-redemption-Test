export function authenticateJob(request: Request) {
  const expected = process.env.JOB_AUTH_SECRET;
  const received = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || received !== expected) throw new Response("Unauthorized", { status: 401 });
}
