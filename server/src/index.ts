import express, { type NextFunction, type Request, type Response } from "express";
import { routes, statusOf } from "./routes.ts";
import { tenant } from "./tenant.ts";

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use("/api", tenant, routes);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const mapped = statusOf(err);
  if (mapped.status >= 500) console.error((err as Error)?.constructor?.name, (err as Error)?.message);
  res.status(mapped.status).json({ error: mapped.error });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`api listening on :${port}`));
