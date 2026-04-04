#!/usr/bin/env bun
/**
 * Interactive Questions UI - Tabbed Navigation Edition
 *
 * Shows visual tabs at the top for all questions with ←/→ navigation
 */

import { readFile, writeFile } from "node:fs/promises";
import type { ClarificationQuestion, ClarificationAnswer } from "./clarifications.ts";
import { createLogger } from "../runtime/logger";

const log = createLogger({ context: { phase: "cli", component: "interactive-questions" } });

type AnswerState = {
  index: number;
  isCustom: boolean;
  value: string;
};

function renderTabs(currentIdx: number, total: number, answered: boolean[]) {
  const tabs: string[] = [];
  for (let i = 0; i < total; i++) {
    const num = i + 1;
    const isCurrent = i === currentIdx;
    const isAnswered = answered[i];
    
    if (isCurrent) {
      tabs.push(`\x1b[1m\x1b[36m[${num}]\x1b[0m`); // Bold cyan for current
    } else if (isAnswered) {
      tabs.push(`\x1b[32m[${num}]\x1b[0m`); // Green for answered
    } else {
      tabs.push(`\x1b[90m[${num}]\x1b[0m`); // Gray for unanswered
    }
  }
  return tabs.join(" ");
}

async function promptMultipleChoice(params: {
  question: string;
  choices: Array<{ label: string; description: string }>;
  questionIndex: number;
  totalQuestions: number;
  answered: boolean[];
  allowCustom?: boolean;
  previousAnswer?: AnswerState;
}): Promise<{ index: number; isCustom: boolean; customValue?: string; navigateTo?: number }> {
  return await new Promise((resolve) => {
    let selectedIndex = params.previousAnswer?.index ?? 0;
    let customInputMode = false;
    let customInputValue = params.previousAnswer?.isCustom ? params.previousAnswer.value : "";
    const totalChoices = params.choices.length + (params.allowCustom ? 1 : 0);
    
    if (selectedIndex >= totalChoices) selectedIndex = 0;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const render = () => {
      process.stdout.write("\x1B[2J\x1B[H");
      
      // Tab bar at top
      process.stdout.write(renderTabs(params.questionIndex, params.totalQuestions, params.answered) + "\n");
      process.stdout.write("\n");

      // Progress
      process.stdout.write(`\x1b[1mQuestion ${params.questionIndex + 1} of ${params.totalQuestions}\x1b[0m\n\n`);

      // Question
      process.stdout.write(`${params.question}\n\n`);

      // Choices
      for (let i = 0; i < params.choices.length; i++) {
        const choice = params.choices[i];
        const prefix = i === selectedIndex && !customInputMode ? "→ " : "  ";
        const highlight = i === selectedIndex && !customInputMode ? "\x1b[1m\x1b[36m" : "";
        const reset = i === selectedIndex && !customInputMode ? "\x1b[0m" : "";
        process.stdout.write(`${highlight}${prefix}${i + 1}. ${choice.label}${reset}\n`);
        process.stdout.write(`     ${choice.description}\n\n`);
      }

      if (params.allowCustom) {
        const customIndex = params.choices.length;
        const isCustomSelected = customIndex === selectedIndex;
        const prefix = isCustomSelected && !customInputMode ? "→ " : "  ";
        const highlight = isCustomSelected && !customInputMode ? "\x1b[1m\x1b[36m" : "";
        const reset = isCustomSelected && !customInputMode ? "\x1b[0m" : "";

        process.stdout.write(`${highlight}${prefix}${customIndex + 1}. Custom Answer${reset}\n`);
        process.stdout.write(`     Write your own answer\n\n`);

        if (isCustomSelected || customInputMode) {
          process.stdout.write("\x1b[1m\x1b[33m✎ Your answer:\x1b[0m\n");
          process.stdout.write(`┌${"─".repeat(78)}┐\n`);
          const displayValue = customInputValue.slice(0, 76);
          process.stdout.write(`│ \x1b[36m${displayValue}\x1b[7m \x1b[0m${" ".repeat(Math.max(0, 76 - displayValue.length))}│\n`);
          process.stdout.write(`└${"─".repeat(78)}┘\n`);
        }
      }

      // Navigation hints
      process.stdout.write("\n\x1b[90m" + "─".repeat(80) + "\x1b[0m\n");
      const hints = [
        "↑/↓: Navigate choices",
        "Enter: Confirm",
        "←/→ or ,/.: Switch question",
        params.questionIndex === params.totalQuestions - 1 ? "F: Finish" : null,
        "Ctrl+C: Cancel",
        "1-" + totalChoices + ": Quick select",
      ].filter(Boolean);
      process.stdout.write("\x1b[90m" + hints.join(" | ") + "\x1b[0m\n");
    };

    render();

    const onKeypress = async (key: string) => {
      const isOnCustomOption = params.allowCustom && selectedIndex === params.choices.length;

      if (key === "\u001b[A") {
        selectedIndex = (selectedIndex - 1 + totalChoices) % totalChoices;
        if (!isOnCustomOption) {
          customInputValue = "";
          customInputMode = false;
        }
        render();
      } else if (key === "\u001b[B") {
        selectedIndex = (selectedIndex + 1) % totalChoices;
        if (!isOnCustomOption) {
          customInputValue = "";
          customInputMode = false;
        }
        render();
      } else if (key === "\u001b[D" || key === "," || key === "\u001b[C" || key === ".") {
        // Left/right arrows or comma/period to switch questions
        const direction = (key === "\u001b[D" || key === ",") ? -1 : 1;
        const newIndex = params.questionIndex + direction;
        if (newIndex >= 0 && newIndex < params.totalQuestions) {
          cleanup();
          resolve({ 
            index: selectedIndex, 
            isCustom: customInputMode || (isOnCustomOption && customInputValue.length > 0), 
            customValue: customInputValue,
            navigateTo: newIndex 
          });
        }
      } else if (key === "f" || key === "F") {
        if (params.questionIndex === params.totalQuestions - 1) {
          cleanup();
          resolve({ 
            index: selectedIndex, 
            isCustom: customInputMode || (isOnCustomOption && customInputValue.length > 0), 
            customValue: customInputValue 
          });
        }
      } else if (key === "\r" || key === "\n") {
        if (isOnCustomOption) {
          if (customInputValue.trim()) {
            cleanup();
            resolve({ index: params.choices.length, isCustom: true, customValue: customInputValue.trim() });
          } else {
            customInputMode = true;
            render();
          }
        } else {
          cleanup();
          resolve({ index: selectedIndex, isCustom: false });
        }
      } else if (key === "\u0003") {
        cleanup();
        process.stdout.write("\n\nCancelled\n");
        process.exit(1);
      } else if (key === "\u007f" || key === "\b") {
        if (isOnCustomOption && customInputValue.length > 0) {
          customInputValue = customInputValue.slice(0, -1);
          customInputMode = true;
          render();
        }
      } else if (key.length === 1 && key >= " " && key <= "~") {
        const num = parseInt(key, 10);
        if (!isNaN(num) && num >= 1 && num <= totalChoices && !customInputMode) {
          selectedIndex = num - 1;
          customInputValue = "";
          customInputMode = false;
          render();
        } else if (isOnCustomOption) {
          customInputValue += key;
          customInputMode = true;
          render();
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    process.stdin.on("data", onKeypress);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    log.error("Usage: bun interactive-questions.ts <questions-file.json> <answers-output.json>");
    process.exit(1);
  }

  const [questionsPath, answersPath] = args;

  const questionsJson = await readFile(questionsPath, "utf8");
  const questionsData = JSON.parse(questionsJson);
  const questions: ClarificationQuestion[] = questionsData.questions;

  if (!Array.isArray(questions) || questions.length === 0) {
    log.error("Error: Questions file must contain a non-empty 'questions' array");
    process.exit(1);
  }

  const answers: ClarificationAnswer[] = [];
  const answerStates: (AnswerState | undefined)[] = new Array(questions.length).fill(undefined);
  const answered: boolean[] = new Array(questions.length).fill(false);
  
  let currentQuestionIndex = 0;

  while (currentQuestionIndex < questions.length) {
    const q = questions[currentQuestionIndex];
    const previousState = answerStates[currentQuestionIndex];

    const result = await promptMultipleChoice({
      question: q.question,
      choices: q.choices,
      questionIndex: currentQuestionIndex,
      totalQuestions: questions.length,
      answered,
      allowCustom: true,
      previousAnswer: previousState,
    });

    // Save answer
    if (result.isCustom && result.customValue) {
      answerStates[currentQuestionIndex] = {
        index: result.index,
        isCustom: true,
        value: result.customValue,
      };
    } else {
      answerStates[currentQuestionIndex] = {
        index: result.index,
        isCustom: false,
        value: q.choices[result.index].label,
      };
    }
    answered[currentQuestionIndex] = true;

    // Navigate
    if (result.navigateTo !== undefined) {
      currentQuestionIndex = result.navigateTo;
    } else {
      currentQuestionIndex++;
    }
  }

  // Build final answers
  for (let i = 0; i < questions.length; i++) {
    const state = answerStates[i];
    const q = questions[i];
    
    if (!state) {
      answers.push({
        question: q.question,
        answer: `${q.choices[0].label}: ${q.choices[0].description}`,
        isCustom: false,
      });
    } else if (state.isCustom) {
      answers.push({
        question: q.question,
        answer: state.value,
        isCustom: true,
      });
    } else {
      const choice = q.choices[state.index];
      answers.push({
        question: q.question,
        answer: `${choice.label}: ${choice.description}`,
        isCustom: false,
      });
    }
  }

  // Summary
  process.stdout.write("\x1B[2J\x1B[H");
  log.info("\n" + "=".repeat(80));
  log.info("CLARIFICATION COMPLETE");
  log.info("=".repeat(80) + "\n");

  const summary = answers
    .map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
    .join("\n\n");

  log.info("Your answers:\n");
  log.info(summary);
  log.info("");

  await writeFile(answersPath, JSON.stringify({ answers }, null, 2), "utf8");
  log.info(`\nAnswers saved to: ${answersPath}\n`);
  process.exit(0);
}

main().catch((error) => {
  log.error("Error:", error.message);
  process.exit(1);
});
