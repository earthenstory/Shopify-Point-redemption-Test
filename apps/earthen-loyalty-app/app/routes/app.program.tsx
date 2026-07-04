import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  formBoolean,
  getLoyaltyRuntimeSettings,
  updateProgramSettings,
} from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });

  return {
    status: settings.program.status,
    programName: settings.program.programName,
    pointName: settings.program.pointName,
    bonWidgetDisabled: settings.program.bonWidgetDisabled,
    standardCheckoutTested: settings.program.standardCheckoutTested,
    expressCheckoutTested: settings.program.expressCheckoutTested,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    await updateProgramSettings({
      db,
      shopDomain: session.shop,
      adminUser: session.id,
      data: {
        status: String(form.get("status")) as "test" | "active" | "paused",
        programName: String(form.get("programName")),
        pointName: String(form.get("pointName")),
        bonWidgetDisabled: formBoolean(form.get("bonWidgetDisabled")),
        standardCheckoutTested: formBoolean(form.get("standardCheckoutTested")),
        expressCheckoutTested: formBoolean(form.get("expressCheckoutTested")),
      },
    });
    return { ok: true, message: "Program settings saved." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not save settings.",
    };
  }
};

const STATUS_TONE: Record<string, "info" | "success" | "warning"> = {
  test: "info",
  active: "success",
  paused: "warning",
};

export default function ProgramPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Point program">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <s-section heading="Program status">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text>Current status</s-text>
              <s-badge tone={STATUS_TONE[data.status] ?? "info"}>
                {data.status === "active"
                  ? "Active"
                  : data.status === "paused"
                    ? "Paused"
                    : "Test mode"}
              </s-badge>
            </s-stack>
            <s-paragraph>
              Set the program live, keep it in test mode while you verify checkout,
              or pause earning and redemption entirely.
            </s-paragraph>
          </s-stack>
        </s-section>

        <Form method="post">
          <s-stack direction="block" gap="large-100">
            <s-section heading="Program details">
              <s-stack direction="block" gap="base">
                <s-select name="status" label="Status" value={data.status}>
                  <s-option value="test">Test mode</s-option>
                  <s-option value="active">Active</s-option>
                  <s-option value="paused">Paused</s-option>
                </s-select>
                <s-text-field
                  name="programName"
                  label="Program name"
                  defaultValue={data.programName}
                  details="The name customers see in the loyalty widget."
                />
                <s-text-field
                  name="pointName"
                  label="Point name"
                  defaultValue={data.pointName}
                  details="What you call your points, e.g. Earthen Points."
                />
              </s-stack>
            </s-section>

            <s-section heading="Checkout & widget">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="bonWidgetDisabled"
                  value="true"
                  defaultChecked={data.bonWidgetDisabled}
                  label="Legacy BON storefront widget is disabled"
                  details="Turn on once the old BON widget/app embed is removed, to avoid two loyalty widgets showing."
                />
                <s-checkbox
                  name="standardCheckoutTested"
                  value="true"
                  defaultChecked={data.standardCheckoutTested}
                  label="Standard checkout tested"
                />
                <s-checkbox
                  name="expressCheckoutTested"
                  value="true"
                  defaultChecked={data.expressCheckoutTested}
                  label="Express checkout tested (or express checkout suppressed)"
                />
              </s-stack>
            </s-section>

            <s-stack direction="inline" gap="base">
              <s-button variant="primary" type="submit">
                Save program settings
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
