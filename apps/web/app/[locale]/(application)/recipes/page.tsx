import { RecipesSurface } from '@/components/recipes/recipes-surface';

export default async function RecipesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <RecipesSurface locale={locale} />;
}
