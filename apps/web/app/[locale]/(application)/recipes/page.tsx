import { RecipesSurface } from '@/components/recipes/recipes-surface';

export default function RecipesPage({ params }: { params: { locale: string } }) {
  return <RecipesSurface locale={params.locale} />;
}
