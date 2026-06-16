"use client";

import { cn } from "@/lib/utils";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

interface RecommendedQuestion {
  id: string;
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
}

const RECOMMENDED_QUESTIONS: RecommendedQuestion[] = [
  {
    id: "dailyUpdate",
    titleKey: "recommendedQuestions.dailyUpdate.title",
    descriptionKey: "recommendedQuestions.dailyUpdate.description",
    promptKey: "recommendedQuestions.dailyUpdate.prompt",
  },
  {
    id: "weeklyReport",
    titleKey: "recommendedQuestions.weeklyReport.title",
    descriptionKey: "recommendedQuestions.weeklyReport.description",
    promptKey: "recommendedQuestions.weeklyReport.prompt",
  },
  {
    id: "followThrough",
    titleKey: "recommendedQuestions.followThrough.title",
    descriptionKey: "recommendedQuestions.followThrough.description",
    promptKey: "recommendedQuestions.followThrough.prompt",
  },
  {
    id: "morningBrief",
    titleKey: "recommendedQuestions.morningBrief.title",
    descriptionKey: "recommendedQuestions.morningBrief.description",
    promptKey: "recommendedQuestions.morningBrief.prompt",
  },
  {
    id: "projectStatus",
    titleKey: "recommendedQuestions.projectStatus.title",
    descriptionKey: "recommendedQuestions.projectStatus.description",
    promptKey: "recommendedQuestions.projectStatus.prompt",
  },
  {
    id: "sortInbox",
    titleKey: "recommendedQuestions.sortInbox.title",
    descriptionKey: "recommendedQuestions.sortInbox.description",
    promptKey: "recommendedQuestions.sortInbox.prompt",
  },
];

interface RecommendedQuestionsProps {
  onQuestionClick: (prompt: string) => void;
  disabled?: boolean;
}

export function RecommendedQuestions({
  onQuestionClick,
  disabled = false,
}: RecommendedQuestionsProps) {
  const { t } = useTranslation();

  const handleClick = useCallback(
    (question: RecommendedQuestion) => {
      const prompt = t(question.promptKey);
      onQuestionClick(prompt);
    },
    [onQuestionClick, t],
  );

  return (
    <div className="mt-[24px] grid w-full grid-cols-3 gap-2">
      {RECOMMENDED_QUESTIONS.map((question) => (
        <button
          key={question.id}
          type="button"
          onClick={() => handleClick(question)}
          disabled={disabled}
          className={cn(
            "flex flex-col items-start rounded-lg border border-[#E9E9E9] bg-white p-2",
            "text-left transition-all duration-200",
            "hover:border-[#EEEFF2] hover:bg-[#EEEFF2]",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          <span className="text-sm font-semibold leading-5 text-[#000000]">
            {t(question.titleKey)}
          </span>
          <span
            className="mt-1 text-xs font-normal leading-4"
            style={{ color: "rgba(0, 0, 0, 0.5)" }}
          >
            {t(question.descriptionKey)}
          </span>
        </button>
      ))}
    </div>
  );
}
