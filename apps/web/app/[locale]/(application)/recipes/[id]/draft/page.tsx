import { DraftRecipeEditorSurface } from '@/components/recipes/draft-recipe-editor-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

export default async function DraftRecipePage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'] }>;
}) {
  const { id: recipeId } = await params;
  return <DraftRecipeEditorSurface recipeId={recipeId} />;
}
