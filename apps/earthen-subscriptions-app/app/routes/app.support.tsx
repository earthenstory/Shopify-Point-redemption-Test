import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { getAdminConfiguration, readinessReport } from "../subscriptions/admin-config";
import { AdminStyles, ModuleCard } from "../components/admin-ui";

export const loader = async ({ request }: LoaderFunctionArgs) => { const { session } = await authenticate.admin(request); const { settings, modules } = await getAdminConfiguration(db, session.shop); return { readiness: readinessReport(settings, modules.installation), shop: session.shop }; };

export default function SupportPage() { const { readiness, shop } = useLoaderData<typeof loader>(); return <s-page heading="Support center"><AdminStyles/><s-stack direction="block" gap="base">
  <s-banner tone={readiness.launchReady ? "success" : "warning"}>{readiness.launchReady ? "The subscription system passes all required launch checks." : "Keep the master switch off until the required launch checks below are complete."}</s-banner>
  <s-section heading="Launch diagnostics"><div className="es-progress"><span style={{width: `${readiness.completed / readiness.total * 100}%`}}/></div>{readiness.checks.map((check) => <div className="es-check" key={check.key}><span className="es-check-dot" data-ready={check.ready}>{check.ready ? "✓" : "!"}</span><div><strong>{check.label}</strong><br/><span className="es-muted">{check.ready ? "Ready" : check.optional ? "Optional until launch" : "Required before launch"}</span></div></div>)}</s-section>
  <div className="es-admin-grid"><ModuleCard href="/app/settings?section=installation" title="Installation help" description="Theme, checkout and customer-account blocks."/><ModuleCard href="/app/health" title="Technical health" description="Inspect payments, webhooks, jobs and notifications."/><ModuleCard href="/app/operations?section=imports" title="Migration center" description="Prepare imports from Seal or another subscription system."/><ModuleCard href={`/app/privacy-export`} title="Privacy tools" description="Export customer subscription data when requested."/></div>
  <s-section heading="Operational runbook"><s-paragraph>1. Configure products and pricing. 2. Verify theme/account extensions. 3. Configure Razorpay, scheduler and notification providers. 4. Complete a UPI AutoPay test subscription and renewal. 5. Review health and analytics. 6. Turn on the master switch.</s-paragraph><s-paragraph>Store: <code>{shop}</code>. The app deliberately blocks activation when required infrastructure is missing.</s-paragraph></s-section>
</s-stack></s-page>; }
