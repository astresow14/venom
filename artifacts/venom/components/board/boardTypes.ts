

export type CardControlHandle = {
  focus?: () => void;
};
export type CardControlHandles = {
  edit: CardControlHandle | null;
  next: CardControlHandle | null;
};

/**
 * Where keyboard focus should land after the card editor closes: back on a
 * card's controls, or on a stage's "Add card" control when a deletion left
 * the stage without any card to return to.
 */
export type BoardFocusTarget =
  | { kind: "card"; taskId: string }
  | { kind: "addCard"; stageId: string };
