import { redirect } from "next/navigation";

export default async function TunnelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect("/forwards/" + id);
}
