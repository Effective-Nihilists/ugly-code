import { defineWorker, defineWorkers } from 'ugly-app/shared';

export const cronTasks = defineWorkers({
  dailyCleanup: defineWorker({
    schedule: '0 3 * * *', // 3 AM UTC daily
    description: 'Delete completed todos older than 30 days',
  }),
});
