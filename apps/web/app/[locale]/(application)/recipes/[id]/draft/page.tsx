import { DraftRecipeEditorSurface } from '@/components/recipes/draft-recipe-editor-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

export default function DraftRecipePage({
  params,
}: {
  params: { id: FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'] };
}) {
  return <DraftRecipeEditorSurface recipeId={params.id} />;
}
