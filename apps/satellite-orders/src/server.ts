import { createApp } from "./app.js";
import { OrderRepository, seedOrders } from "./repository.js";

const port = Number(process.env["PORT"] ?? 4001);
const principalSecret = process.env["PORTAL_PRINCIPAL_SECRET"];

if (!principalSecret) {
  // Failing loudly beats defaulting to a well-known secret. A satellite that
  // cannot verify identities must not start.
  console.error("PORTAL_PRINCIPAL_SECRET is required");
  process.exit(1);
}

const app = createApp({
  repository: new OrderRepository(seedOrders()),
  principalSecret,
});

const server = app.listen(port, () => {
  console.log(`satellite-orders listening on :${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
