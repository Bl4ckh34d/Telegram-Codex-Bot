"use strict";
const acorn = require("acorn");
function readDataVariable(script, name) {
  if (Buffer.byteLength(script, "utf8") > 1024 * 1024) throw new Error("Data script exceeds size limit");
  const ast = acorn.parse(script, { ecmaVersion: 2020 });
  function literal(node, depth = 0) {
    if (!node || depth > 64) throw new Error("Invalid or excessively nested data");
    if (node.type === "Literal" && !node.regex && typeof node.value !== "bigint") return node.value;
    if (node.type === "ArrayExpression") return node.elements.map(x => literal(x, depth + 1));
    if (node.type === "ObjectExpression") {
      const out = Object.create(null);
      for (const p of node.properties) {
        if (p.type !== "Property" || p.kind !== "init" || p.computed || p.method || p.shorthand) throw new Error("Executable property in data script");
        const key = p.key.type === "Identifier" ? p.key.name : p.key.value;
        if (["__proto__", "constructor", "prototype"].includes(String(key))) throw new Error("Unsafe data property");
        out[key] = literal(p.value, depth + 1);
      }
      return out;
    }
    if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") return -node.argument.value;
    throw new Error("Executable expression in data script");
  }
  let value = null;
  for (const statement of ast.body) {
    if (statement.type === "EmptyStatement") continue;
    if (statement.type !== "VariableDeclaration") throw new Error("Only data declarations are accepted");
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier") throw new Error("Invalid data declaration");
      const parsed = literal(declaration.init);
      if (declaration.id.name === name) value = parsed;
    }
  }
  return value;
}
module.exports = { readDataVariable };
