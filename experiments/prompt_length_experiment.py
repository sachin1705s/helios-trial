"""
Response Length Strategy Experiment
====================================
Tests 5 length-directive strategies against 3 characters and 6 question types.
Uses Gemini API (no Ollama required).

Setup:
  pip install -r experiments/requirements.txt

Run from project root:
  python experiments/prompt_length_experiment.py

Results are printed to stdout and saved to experiments/results.md
"""

import os
import sys
import time
import textwrap
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

try:
    import google.generativeai as genai
except ImportError:
    sys.exit("Missing dependency: pip install -r experiments/requirements.txt")

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    sys.exit("GEMINI_API_KEY not found in environment. Add it to .env")

genai.configure(api_key=API_KEY)
MODEL = "gemini-2.0-flash"

# ---------------------------------------------------------------------------
# 5 strategies to test
# ---------------------------------------------------------------------------
STRATEGIES = {
    "baseline_25w": (
        "Keep every reply under 25 words. Short punchy sentences only. "
        "If explaining something, use at most 25 words. If just reacting, use under 10 words."
    ),
    "no_cap": "",  # No length instruction — raw model behaviour
    "match_question": (
        "Match your response length to the depth of the question."
    ),
    "context_aware": (
        "Keep replies to 2–3 sentences unless the question starts with "
        "explain, how, why, or tell me."
    ),
    "two_burst": (
        "Always reply in exactly two short beats separated by a pause beat (…). "
        "First beat: a sharp 1-sentence reaction. Second beat: a 1-sentence elaboration or question. "
        "Total: never more than 30 words."
    ),
}

# ---------------------------------------------------------------------------
# 3 characters with their base system prompts (stripped of length directive)
# ---------------------------------------------------------------------------
CHARACTERS = {
    "einstein": (
        "You are Albert Einstein — curious, warm, and full of wonder. "
        "You have a gentle sense of humour and love making the impossible feel simple. "
        "You explain big ideas through everyday objects. "
        "Personality: childlike curiosity, dry wit, self-deprecating charm."
    ),
    "alexander": (
        "You are Alexander the Great — bold, magnetic, and utterly certain of your destiny. "
        "You speak with the authority of someone who has never lost. "
        "You think in armies, maps, terrain, and tactics. "
        "Personality: commanding but not cruel. You respect courage above all things."
    ),
    "cleopatra": (
        "You are Cleopatra, Queen of the Nile — regal, razor-sharp, and in complete command. "
        "You speak through the symbols of your world. "
        "Personality: supremely confident but never cold. "
        "You find humans endlessly interesting."
    ),
}

# ---------------------------------------------------------------------------
# 6 test questions: 3 casual + 3 deep
# ---------------------------------------------------------------------------
QUESTIONS = [
    # Casual
    ("casual", "Hi! How are you?"),
    ("casual", "What's your favourite thing?"),
    ("casual", "Are you famous?"),
    # Deep
    ("deep", "Explain how gravity actually works."),
    ("deep", "How did you manage to win so many battles?"),
    ("deep", "Why is knowledge more powerful than any army?"),
]


def ask(character_id: str, strategy_id: str, question: str) -> str:
    base_prompt = CHARACTERS[character_id]
    length_directive = STRATEGIES[strategy_id]
    system = f"{base_prompt}\n{length_directive}".strip()

    model = genai.GenerativeModel(
        model_name=MODEL,
        system_instruction=system,
    )
    response = model.generate_content(question)
    return response.text.strip()


def word_count(text: str) -> int:
    return len(text.split())


def run_experiment():
    results: list[dict] = []

    total = len(STRATEGIES) * len(CHARACTERS) * len(QUESTIONS)
    done = 0

    print(f"\nRunning {total} calls against {MODEL}...\n")

    for strategy_id in STRATEGIES:
        for char_id in CHARACTERS:
            for q_type, question in QUESTIONS:
                done += 1
                print(f"[{done}/{total}] {strategy_id} / {char_id} / {q_type}: {question[:40]}...")
                try:
                    answer = ask(char_id, strategy_id, question)
                    wc = word_count(answer)
                    results.append({
                        "strategy": strategy_id,
                        "character": char_id,
                        "q_type": q_type,
                        "question": question,
                        "answer": answer,
                        "words": wc,
                    })
                except Exception as e:
                    print(f"  ERROR: {e}")
                    results.append({
                        "strategy": strategy_id,
                        "character": char_id,
                        "q_type": q_type,
                        "question": question,
                        "answer": f"ERROR: {e}",
                        "words": 0,
                    })
                time.sleep(0.5)  # gentle rate limiting

    return results


def render_results(results: list[dict]) -> str:
    lines = ["# Response Length Experiment Results\n"]
    lines.append(f"Model: `{MODEL}`  \n")
    lines.append(f"Total calls: {len(results)}\n\n---\n")

    # Summary table: avg words per strategy × question type
    lines.append("## Average word count by strategy\n")
    lines.append("| Strategy | Casual avg | Deep avg | Ratio (deep/casual) |")
    lines.append("|---|---|---|---|")

    for strategy_id in STRATEGIES:
        casual_words = [r["words"] for r in results if r["strategy"] == strategy_id and r["q_type"] == "casual"]
        deep_words   = [r["words"] for r in results if r["strategy"] == strategy_id and r["q_type"] == "deep"]
        c_avg = sum(casual_words) / len(casual_words) if casual_words else 0
        d_avg = sum(deep_words)   / len(deep_words)   if deep_words   else 0
        ratio = f"{d_avg / c_avg:.1f}x" if c_avg > 0 else "n/a"
        lines.append(f"| `{strategy_id}` | {c_avg:.0f} | {d_avg:.0f} | {ratio} |")

    lines.append("\n---\n")

    # Full responses grouped by strategy
    lines.append("## Full responses\n")
    for strategy_id in STRATEGIES:
        lines.append(f"### Strategy: `{strategy_id}`\n")
        lines.append(f"> {STRATEGIES[strategy_id] or '*(no length directive)*'}\n")
        for char_id in CHARACTERS:
            lines.append(f"\n#### {char_id.capitalize()}\n")
            for r in results:
                if r["strategy"] == strategy_id and r["character"] == char_id:
                    tag = f"[{r['q_type'].upper()} — {r['words']}w]"
                    lines.append(f"**Q ({r['q_type']}):** {r['question']}  ")
                    lines.append(f"**A {tag}:** {r['answer']}\n")

    return "\n".join(lines)


def main():
    results = run_experiment()

    output = render_results(results)

    out_path = Path(__file__).parent / "results.md"
    out_path.write_text(output, encoding="utf-8")

    print("\n" + "=" * 60)
    print(output[:3000])  # preview first 3000 chars in terminal
    if len(output) > 3000:
        print(f"\n... (truncated — full results in experiments/results.md)")
    print("=" * 60)
    print(f"\nFull results saved to: {out_path}")


if __name__ == "__main__":
    main()
