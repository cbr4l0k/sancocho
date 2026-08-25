import { RecipeDetailSurface } from '@/components/recipes/recipe-detail-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@priamo/convex/api';

export default async function RecipeDetailPage({
  params,
}: {
  params: Promise<{ id: FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'] }>;
}) {
  const { id: recipeId } = await params;
  return <RecipeDetailSurface recipeId={recipeId} />;
}
