export {
  getRedisWriter,
  buildRedisForWorker,
  closeRedisWriter
} from "./redis.js";

export {
  QUEUE_WA_INBOUND,
  QUEUE_WA_OUTBOUND,
  QUEUE_LEAD_NOTIFY,
  QUEUE_WA_FLUSH,
  QUEUE_STYLE_ANALYZE,
  QUEUE_WA_FOLLOWUP,
  getQueue,
  getInboundQueue,
  getOutboundQueue,
  OUTBOUND_JOB_OPTIONS,
  getLeadNotifyQueue,
  getFlushQueue,
  getStyleAnalyzeQueue,
  getFollowupQueue,
  startWorker,
  closeAllQueues,
  type WaInboundJob,
  type WaOutboundJob,
  type LeadNotifyJob,
  type WaFlushJob,
  type StyleAnalyzeJob,
  type FollowupJob,
  type StartedWorker
} from "./queues.js";

// Re-export BullMQ types для consumer'ов, которые не хотят добавлять
// bullmq в свои deps (например, wa-worker).
export type { Job, Worker } from "bullmq";
