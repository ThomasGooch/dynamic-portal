/**
 * `${VAR}` and `${VAR:-default}` substitution for the registry file.
 *
 * A registry that hardcodes hostnames cannot move between environments: the
 * same file has to say `localhost:4001` on a laptop and `satellite-orders:4001`
 * inside compose. Substitution keeps one reviewed file rather than one per
 * environment, which is the whole reason the registry is config-as-code.
 *
 * Syntax is deliberately the same subset docker-compose uses, so an operator
 * does not have to learn a second convention for the same idea.
 */

export class UnresolvedVariableError extends Error {
  constructor(readonly variable: string) {
    super(
      `Registry references \${${variable}}, which is not set and has no default. ` +
        `Set it, or write \${${variable}:-<fallback>}.`,
    );
    this.name = "UnresolvedVariableError";
  }
}

// `${NAME}` or `${NAME:-default}`. The default runs to the closing brace, so it
// may itself contain colons and slashes — which URLs do.
const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function expandEnv(
  source: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  // `replace` with a function substitutes in one pass, so a value that happens
  // to contain `${...}` is never re-expanded — otherwise whoever sets a
  // variable could inject a reference to another one.
  return source.replace(PATTERN, (_match, name: string, fallback?: string) => {
    const value = env[name];
    // An empty string is *set*. Falling through to the default there would
    // silently override an operator's decision to blank something out.
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    throw new UnresolvedVariableError(name);
  });
}
