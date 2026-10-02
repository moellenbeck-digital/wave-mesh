import { Fragment, type ReactNode } from "react";

/**
 * A sentence with markup in the middle -- "You are now in <strong>home</strong>."
 *
 * The catalog keeps the whole sentence as one string with `{name}` holes,
 * because word order differs between languages and a sentence cut into three
 * catalog entries can only be translated in the order it was cut. The holes
 * are filled here with whatever the page renders there. A hole without a part
 * stays visible as `{name}`, so a mismatch shows up instead of vanishing.
 */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  const pieces = text.split(/\{(\w+)\}/);
  return pieces.map((piece, index) =>
    // Odd indices are the names captured between the braces.
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed sentence never reorder
      <Fragment key={index}>{piece in parts ? parts[piece] : `{${piece}}`}</Fragment>
    ) : (
      piece
    ),
  );
}
