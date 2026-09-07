export type DraftServiceKindField = {
  _id: string;
  fieldDefinitionId: string;
  position: number;
  required: boolean;
  visible: boolean;
};

export type DraftFieldProblem =
  | 'duplicateDefinition'
  | 'duplicatePosition'
  | 'invalidPosition'
  | 'requiredHidden';

export type ServiceKindDraftCheck = {
  empty: boolean;
  fieldProblems: ReadonlyMap<string, readonly DraftFieldProblem[]>;
};

/**
 * Client-side publish pre-flight only. The server remains the authority: it
 * additionally checks definition state, snapshot coherence, and default values.
 */
export function checkServiceKindDraft(fields: readonly DraftServiceKindField[]): ServiceKindDraftCheck {
  const problems = new Map<string, DraftFieldProblem[]>();
  const definitions = new Map<string, string[]>();
  const positions = new Map<number, string[]>();

  function add(fieldId: string, problem: DraftFieldProblem): void {
    const existing = problems.get(fieldId) ?? [];
    existing.push(problem);
    problems.set(fieldId, existing);
  }

  for (const field of fields) {
    const definitionFields = definitions.get(field.fieldDefinitionId) ?? [];
    definitionFields.push(field._id);
    definitions.set(field.fieldDefinitionId, definitionFields);
    if (!Number.isInteger(field.position) || field.position < 0) {
      add(field._id, 'invalidPosition');
    } else {
      const positionFields = positions.get(field.position) ?? [];
      positionFields.push(field._id);
      positions.set(field.position, positionFields);
    }
    if (field.required && !field.visible) add(field._id, 'requiredHidden');
  }

  for (const fieldIds of definitions.values()) {
    if (fieldIds.length > 1) {
      for (const fieldId of fieldIds) add(fieldId, 'duplicateDefinition');
    }
  }
  for (const fieldIds of positions.values()) {
    if (fieldIds.length > 1) {
      for (const fieldId of fieldIds) add(fieldId, 'duplicatePosition');
    }
  }

  return { empty: fields.length === 0, fieldProblems: problems };
}
