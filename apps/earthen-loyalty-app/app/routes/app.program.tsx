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

export default function ProgramPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Point program">
      <s-section heading="Program controls">
        {actionData?.message ? (
          <s-paragraph>{actionData.message}</s-paragraph>
        ) : null}
        <Form method="post">
          <div style={{ display: "grid", gap: 14, maxWidth: 640 }}>
            <label>
              Status
              <select name="status" defaultValue={data.status}>
                <option value="test">Test mode</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </label>
            <label>
              Program name
              <input
                name="programName"
                defaultValue={data.programName}
                required
                maxLength={80}
              />
            </label>
            <label>
              Point name
              <input
                name="pointName"
                defaultValue={data.pointName}
                required
                maxLength={80}
              />
            </label>
            <label>
              <input
                type="checkbox"
                name="bonWidgetDisabled"
                defaultChecked={data.bonWidgetDisabled}
              />{" "}
              BON storefront widget/app embed is disabled
            </label>
            <label>
              <input
                type="checkbox"
                name="standardCheckoutTested"
                defaultChecked={data.standardCheckoutTested}
              />{" "}
              Standard checkout test passed
            </label>
            <label>
              <input
                type="checkbox"
                name="expressCheckoutTested"
                defaultChecked={data.expressCheckoutTested}
              />{" "}
              Express checkout test passed or express checkout suppressed
            </label>
            <s-button type="submit">Save program settings</s-button>
          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
