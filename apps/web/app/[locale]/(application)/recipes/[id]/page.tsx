import { RecipeDetailSurface } from '@/components/recipes/recipe-detail-surface';
import type { FunctionArgs } from 'convex/server';

import { api } from '@sancocho/convex/api';

export default function RecipeDetailPage({
  params,
}: {
  params: { id: FunctionArgs<typeof api.recipes.queries.getRecipe>['recipeId'] };
}) {
  return <RecipeDetailSurface recipeId={params.id} />;
}
