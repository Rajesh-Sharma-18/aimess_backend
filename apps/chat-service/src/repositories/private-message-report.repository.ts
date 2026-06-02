import type {
  PrismaClient,
  PrivateMessageReport,
} from "../generated/prisma/index.js";

export class PrivateMessageReportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    roomId: string;
    messageId: string;
    reporterId: string;
    reportedUserId: string;
    reason: string;
    description?: string;
  }): Promise<PrivateMessageReport> {
    return this.prisma.privateMessageReport.create({
      data: {
        roomId: data.roomId,
        messageId: data.messageId,
        reporterId: data.reporterId,
        reportedUserId: data.reportedUserId,
        reason: data.reason,
        description: data.description ?? "",
      },
    });
  }

  async findByMessageAndReporter(
    messageId: string,
    reporterId: string
  ): Promise<PrivateMessageReport | null> {
    return this.prisma.privateMessageReport.findUnique({
      where: { messageId_reporterId: { messageId, reporterId } },
    });
  }
}
