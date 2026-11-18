import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { InterviewItem } from '@/api/types';
import { saveBlob } from '@/lib/download';
import { interviewFileName } from './pipeline-model';

export function useInterviewActions(onChanged: () => void) {
  const { busy, run } = useAction();
  const update = (i: InterviewItem, patch: Parameters<typeof homeApi.updateInterview>[1], success: string) => run(() => homeApi.updateInterview(i.id, patch), { success }).then(onChanged);
  const download = (i: InterviewItem) => run(async () => saveBlob(await homeApi.interviewIcs(i.id), interviewFileName(i)), { refresh: false });
  return { busy, update, download };
}

export type InterviewActionsApi = ReturnType<typeof useInterviewActions>;
