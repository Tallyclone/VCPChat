"use strict";

const fs = require("fs/promises");
const path = require("path");
const { shell } = require("electron");

class NativeFsJobs {
  constructor({ sendToDesktop }) {
    this.sendToDesktop = sendToDesktop;
    this.queue = [];
    this.running = new Map();
    this.maxConcurrent = 2;
  }

  createJob({ type, task }) {
    const jobId = `nfsjob-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const controller = new AbortController();
    const job = {
      jobId,
      type,
      task,
      controller,
      status: "queued",
      createdAt: Date.now(),
    };
    this.queue.push(job);
    this._pump();
    return jobId;
  }

  cancel(jobId) {
    const running = this.running.get(jobId);
    if (running) {
      running.controller.abort();
      return { success: true, status: "cancelling" };
    }
    const index = this.queue.findIndex((job) => job.jobId === jobId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this._emit(jobId, { status: "cancelled" });
      return { success: true, status: "cancelled" };
    }
    return { success: false, error: "ERR_JOB_NOT_FOUND" };
  }

  _pump() {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift();
      this._run(job);
    }
  }

  async _run(job) {
    job.status = "running";
    this.running.set(job.jobId, job);
    this._emit(job.jobId, { status: "running", type: job.type });
    try {
      const result = await job.task({
        signal: job.controller.signal,
        progress: (payload) => this._emit(job.jobId, payload),
      });
      this._emit(job.jobId, { status: "completed", result });
    } catch (error) {
      this._emit(job.jobId, {
        status: job.controller.signal.aborted ? "cancelled" : "failed",
        error: error?.message || error?.code || String(error),
      });
    } finally {
      this.running.delete(job.jobId);
      this._pump();
    }
  }

  _emit(jobId, payload) {
    this.sendToDesktop("desktop:nfs:jobProgress", {
      jobId,
      ...payload,
      timestamp: Date.now(),
    });
  }
}

function enrichFsError(error, operation, src, dest) {
  const details = [
    error?.code || error?.message || String(error),
    operation,
    src ? `src=${src}` : null,
    dest ? `dest=${dest}` : null,
    error?.syscall ? `syscall=${error.syscall}` : null,
    error?.path ? `path=${error.path}` : null,
  ].filter(Boolean);
  const enriched = new Error(details.join(" | "));
  enriched.code = error?.code || "ERR_FS_OPERATION_FAILED";
  enriched.cause = error;
  return enriched;
}

async function copyPathRecursive(src, dest, options = {}) {
  if (options.signal?.aborted) throw new Error("ERR_CANCELLED");
  try {
    await fs.cp(src, dest, {
      recursive: true,
      force: options.overwrite === true,
      errorOnExist: options.overwrite !== true,
    });
  } catch (error) {
    throw enrichFsError(error, "copy", src, dest);
  }
}

async function movePath(src, dest, options = {}) {
  if (options.signal?.aborted) throw new Error("ERR_CANCELLED");
  try {
    await fs.rename(src, dest);
  } catch (error) {
    const canFallbackToCopyTrash =
      error.code === "EXDEV" ||
      (process.platform === "win32" && error.code === "EPERM");
    if (!canFallbackToCopyTrash) throw enrichFsError(error, "move", src, dest);
    await copyPathRecursive(src, dest, options);
    try {
      await shell.trashItem(src);
    } catch (trashError) {
      throw enrichFsError(trashError, "trash-after-move-fallback", src, dest);
    }
  }
}

module.exports = {
  NativeFsJobs,
  copyPathRecursive,
  movePath,
};
