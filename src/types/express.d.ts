/**
 * Express 简化类型声明 — 供路由文件 `import type` 使用
 *
 * 项目使用 CJS + tsx 运行时，无需完整 @types/express。
 * 此声明文件仅覆盖路由 handler 中使用到的属性。
 */

declare module 'express' {
  import { IncomingMessage, ServerResponse } from 'http';

  interface Request extends IncomingMessage {
    body: Record<string, unknown>;
    params: Record<string, string>;
    query: Record<string, string | string[] | undefined>;
    headers: Record<string, string | string[] | undefined>;
    user?: {
      userId: string;
      username: string;
      role: string;
    };
    enrollNode?: { nodeId: string };
    ip?: string;
    method: string;
    path: string;
    [key: string]: unknown;
  }

  interface Response extends ServerResponse {
    status(code: number): Response;
    json(body: unknown): Response;
    type(contentType: string): Response;
    send(body: unknown): Response;
    sendFile(path: string): void;
    end(): void;
    redirect(url: string): void;
    set(field: string, value: string): Response;
  }

  type NextFunction = (err?: unknown) => void;

  interface Router {
    get(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Router;
    post(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Router;
    put(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Router;
    patch(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Router;
    delete(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Router;
    use(...args: unknown[]): Router;
  }

  interface Express {
    use(...args: unknown[]): Express;
    get(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Express;
    post(path: string, ...handlers: Array<(req: Request, res: Response, next?: NextFunction) => void>): Express;
    listen(port: number, callback?: () => void): unknown;
  }

  function express(): Express;

  namespace express {
    function Router(): Router;
    function json(options?: Record<string, unknown>): (req: Request, res: Response, next: NextFunction) => void;
    function urlencoded(options?: Record<string, unknown>): (req: Request, res: Response, next: NextFunction) => void;
    function static(root: string, options?: Record<string, unknown>): (req: Request, res: Response, next: NextFunction) => void;
  }

  export = express;
  export { Request, Response, NextFunction, Router };
}
