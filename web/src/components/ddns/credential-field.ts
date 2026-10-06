/**
 * 凭据输入框的读写（**只在这里**碰 `<input>` 的 value）。
 *
 * 为什么不把 token 放进 React state：受控字段会把明文放进 React 树，任何一次
 * SSR / 序列化 / 错误边界重渲染都可能把它写进 HTML 或日志。这里只通过 ref 读一次、
 * 提交后立刻抹掉，于是"不回填、不进 SSR"是**结构上**成立的，而不是靠约定。
 *
 * 之所以单独抽出这两个函数：它们是"成功即清空"这条硬要求的**唯一**实现点，
 * 可以被测试直接驱动（给一个假 input，断言读完清空），不必依赖 DOM 环境。
 */

/** 从输入框读出凭据（两端空白去掉）；没有输入框或为空 ⇒ `""`。 */
export function readCredential(input: { value: string } | null | undefined): string {
  return input?.value.trim() ?? "";
}

/** 提交后清空凭据输入框；成功与失败都必须调用。 */
export function clearCredential(input: { value: string } | null | undefined): void {
  if (input) input.value = "";
}
