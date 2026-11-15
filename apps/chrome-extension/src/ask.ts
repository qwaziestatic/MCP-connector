// How the extension's pages ask the background worker for something.
import type { WorkerReply, WorkerRequest } from "./lib/worker.ts";

export async function ask<T>(request: WorkerRequest): Promise<T> {
  const answer = await chrome.runtime.sendMessage(request) as WorkerReply | undefined;
  if (answer === undefined) throw new Error("The extension's background worker did not answer. Reload the extension.");
  if (!answer.ok) throw new Error(answer.error);
  return answer.value as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds an element. Text is always set as text, never as HTML. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { readonly className?: string; readonly text?: string } = {},
  children: readonly Node[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  node.append(...children);
  return node;
}

export function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = element("button", { className, text: label });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
