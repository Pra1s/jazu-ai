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
  getQueue,
  getInboundQueue,
  getOutboundQueue,
  getLeadNotifyQueue,
  getFlushQueue,
  startWorker,
  closeAllQueues,
  type WaInboundJob,
  type WaOutboundJob,
  type LeadNotifyJob,
  type WaFlushJob,
  type StartedWorker
} from "./queues.js";

// Re-export BullMQ types для consumer'ов, которые не хотят добавлять
// bullmq в свои deps (например, wa-worker).
export type { Job, Worker } from "bullmq";
