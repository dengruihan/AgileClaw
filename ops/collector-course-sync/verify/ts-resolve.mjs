// .js → .ts 解析回退加载器：产品仓库与线上扩展的 TS 源码以 `.js` 扩展名互相引用
// （Node type-stripping 不会自动映射），解析失败后回退到同名 `.ts`。
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw e;
  }
}
