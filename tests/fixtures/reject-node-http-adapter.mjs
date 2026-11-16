export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@hono/node-server") {
    throw new Error("Node HTTP adapter must not load when importing the application");
  }
  return nextResolve(specifier, context);
}
