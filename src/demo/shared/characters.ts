import data from '../../data/characters.json';

export interface DemoCharacter {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  image: string;
  prompt: string;
  cta: string;
  greeting?: string;
}

export const characters: DemoCharacter[] = (data as { characters: DemoCharacter[] }).characters;

export const findCharacter = (id: string | undefined): DemoCharacter | undefined =>
  characters.find((c) => c.id === id);

// Curated landing/featured shortlist — mascot leads, history lineup as second row.
export const featured = ['bear', 'da-vinci'];
