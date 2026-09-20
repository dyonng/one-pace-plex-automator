/** Word the operator has to type to confirm a large destructive batch. */
export const CONFIRM_WORD = "DELETE";

/**
 * Above this many episodes, deleting files needs a typed confirmation. The mass
 * removal incident was one select-all plus one click on a modal whose list
 * scrolled — at that size the modal stops conveying the blast radius, so the
 * action needs a deliberate step instead.
 */
export const DELETE_CONFIRM_THRESHOLD = 5;

export function needsTypeConfirm(deleteFile: boolean, count: number): boolean {
  return deleteFile && count >= DELETE_CONFIRM_THRESHOLD;
}

/** Case- and whitespace-insensitive so the gate is deliberate, not fiddly. */
export function typeConfirmOk(text: string): boolean {
  return text.trim().toUpperCase() === CONFIRM_WORD;
}

/** Whether the confirm button should be enabled. */
export function canConfirmRemove(deleteFile: boolean, count: number, text: string): boolean {
  return !needsTypeConfirm(deleteFile, count) || typeConfirmOk(text);
}
