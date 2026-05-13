export type ObjectCategory =
  | 'food'
  | 'sweet'
  | 'drink'
  | 'fish'
  | 'tech'
  | 'book'
  | 'toy'
  | 'nature'
  | 'tool'
  | 'clothing'
  | 'other';

const CATEGORY_KEYWORDS: Record<ObjectCategory, string[]> = {
  food:     ['apple', 'banana', 'orange', 'fruit', 'vegetable', 'sandwich', 'pizza', 'bread', 'egg', 'meat', 'burger', 'food', 'snack', 'berry', 'berries', 'mushroom', 'carrot', 'potato', 'tomato', 'grape'],
  sweet:    ['candy', 'chocolate', 'cake', 'cookie', 'donut', 'sweet', 'sugar', 'honey', 'ice cream', 'dessert', 'biscuit', 'muffin'],
  drink:    ['cup', 'mug', 'bottle', 'glass', 'can', 'drink', 'coffee', 'tea', 'juice', 'water', 'soda'],
  fish:     ['fish', 'salmon', 'tuna', 'shrimp', 'crab', 'lobster', 'seafood'],
  tech:     ['phone', 'laptop', 'tablet', 'computer', 'keyboard', 'mouse', 'remote', 'camera', 'headphones', 'charger', 'cable', 'device', 'screen', 'monitor', 'controller'],
  book:     ['book', 'magazine', 'newspaper', 'notebook', 'journal', 'paper', 'document', 'comic', 'manual'],
  toy:      ['ball', 'toy', 'game', 'dice', 'lego', 'puzzle', 'doll', 'figurine', 'card'],
  nature:   ['flower', 'plant', 'leaf', 'rock', 'stone', 'stick', 'branch', 'pine', 'cone', 'shell', 'feather', 'grass', 'wood', 'log', 'tree'],
  tool:     ['scissors', 'knife', 'hammer', 'screwdriver', 'wrench', 'pen', 'pencil', 'ruler', 'key', 'brush', 'spoon', 'fork', 'spatula'],
  clothing: ['hat', 'cap', 'glasses', 'sunglasses', 'gloves', 'scarf', 'shoe', 'sock', 'shirt', 'jacket', 'bag', 'wallet', 'watch'],
  other:    [],
};

export function categorize(description: string): ObjectCategory {
  const lower = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [ObjectCategory, string[]][]) {
    if (category === 'other') continue;
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return 'other';
}

// Bear-specific interaction prompts per category.
// The {object} placeholder is replaced with the detected object name.
export const BEAR_PROMPTS: Record<ObjectCategory, string> = {
  food:     'The user just handed you {object}. As Steve the Bear, react with your natural foraging instincts — sniff it, consider eating it — in ONE sentence under 20 words. Respond in English.',
  sweet:    'The user just handed you {object}. As Steve the Bear who is obsessed with honey and sweet things, react with excitement in ONE sentence under 20 words. Respond in English.',
  drink:    'The user just handed you {object}. As Steve the Bear, sniff it curiously and react to what it smells like in ONE sentence under 20 words. Respond in English.',
  fish:     'The user just handed you {object}. As Steve the Bear whose favourite food is fish, react with pure delight in ONE sentence under 20 words. Respond in English.',
  tech:     'The user just handed you {object}. As Steve the Bear who has never seen technology, react with bewildered curiosity — paw at it gently — in ONE sentence under 20 words. Respond in English.',
  book:     'The user just handed you {object}. As Steve the Bear, hold it carefully in your paws and react thoughtfully in ONE sentence under 20 words. Respond in English.',
  toy:      'The user just handed you {object}. As Steve the Bear, react with playful excitement and describe what you do with it in ONE sentence under 20 words. Respond in English.',
  nature:   'The user just handed you {object}. As Steve the Bear, recognise it from the forest and react with warmth and familiarity in ONE sentence under 20 words. Respond in English.',
  tool:     'The user just handed you {object}. As Steve the Bear, hold it awkwardly in your big paws and react with gentle confusion in ONE sentence under 20 words. Respond in English.',
  clothing:'The user just handed you {object}. As Steve the Bear, try to figure out what it is and react with curious amusement in ONE sentence under 20 words. Respond in English.',
  other:    'The user just handed you {object}. As Steve the Bear, physically receive it and react with warm curiosity in ONE sentence under 20 words. Respond in English.',
};

export function buildBearPrompt(description: string): string {
  const category = categorize(description);
  const template = BEAR_PROMPTS[category];
  return template.replace('{object}', description);
}
