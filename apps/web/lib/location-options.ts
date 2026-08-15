export type LocationOption<T> = {
  location: T;
  isArchived: boolean;
};

type LocationOptionInput = {
  _id: string;
  status: 'active' | 'archived';
};

/** Assembles active loaded options with the resolved selection, including an archived selection when needed. */
export function buildLocationOptions<T extends LocationOptionInput>({
  loaded,
  selected,
}: {
  loaded: readonly T[];
  selected: T | undefined;
}): LocationOption<T>[] {
  const activeLoaded = loaded.filter((location) => location.status === 'active');
  const loadedOptions = activeLoaded.map((location) => ({ location, isArchived: false }));

  if (selected === undefined || activeLoaded.some((location) => location._id === selected._id)) return loadedOptions;

  return [{ location: selected, isArchived: selected.status === 'archived' }, ...loadedOptions];
}
