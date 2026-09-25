/**
 * app/api/settings/[installationId]/route.ts
 *
 * GET /api/settings/[installationId]
 *   Returns the notification and alert settings for the GitHub installation.
 *
 * POST /api/settings/[installationId]
 *   Updates the alert settings (recipients, notification thresholds, Slack webhook).
 *   Optionally triggers a test email verification.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getAlertSettings,
  saveAlertSettings,
  sendTestAlertEmail,
  type AlertSettings,
} from "@/agents/email-agent";

export const dynamic = "force-dynamic";

interface RouteParams {
  params:
    | { installationId: string }
    | Promise<{ installationId: string }>;
}

export async function GET(
  _request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const resolvedParams = await Promise.resolve(params);
  const { installationId } = resolvedParams;

  if (!installationId) {
    return NextResponse.json(
      { error: "installationId is required" },
      { status: 400 }
    );
  }

  try {
    const settings = await getAlertSettings(installationId);
    return NextResponse.json({ settings }, { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to retrieve alert settings", details: msg },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const resolvedParams = await Promise.resolve(params);
  const { installationId } = resolvedParams;

  if (!installationId) {
    return NextResponse.json(
      { error: "installationId is required" },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();

    // Check if client requested a test email
    if (body.testEmail) {
      const recipient = String(body.testEmail || "").trim();
      if (!recipient || !recipient.includes("@")) {
        return NextResponse.json(
          { error: "Invalid test email recipient provided" },
          { status: 400 }
        );
      }

      console.log(`[settings-api] Sending test alert email to ${recipient}...`);
      const testResult = await sendTestAlertEmail(recipient, installationId);

      if (!testResult.success) {
        return NextResponse.json(
          { error: "Failed to send test email", details: testResult.error },
          { status: 500 }
        );
      }

      return NextResponse.json(
        { message: "Test alert email sent successfully!", messageId: testResult.messageId },
        { status: 200 }
      );
    }

    // Otherwise, save settings
    const newSettings: AlertSettings = {
      installationId,
      alertEmail: typeof body.alertEmail === "string" ? body.alertEmail.trim() : undefined,
      notifyOnBlock: body.notifyOnBlock !== false,
      notifyOnWarn: body.notifyOnWarn !== false,
      notifyOnPass: Boolean(body.notifyOnPass),
      slackWebhookUrl: typeof body.slackWebhookUrl === "string" ? body.slackWebhookUrl.trim() : undefined,
    };

    const saved = await saveAlertSettings(newSettings);
    return NextResponse.json({ message: "Settings saved successfully", settings: saved }, { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to save alert settings", details: msg },
      { status: 500 }
    );
  }
}
