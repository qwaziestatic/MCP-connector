import { handleRequest, type Env } from "./notion-sign-in.ts";

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env)
};
