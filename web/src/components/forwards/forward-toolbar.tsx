"use client";
import { Plus, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select";
import type { UserNode } from "@/lib/types";
import type { ForwardModeFilter,ForwardStatusFilter } from "@/components/forwards/forward-list-model";
type Translate=(key:string,params?:Record<string,string|number>)=>string;
export function ForwardToolbar({mode,status,ingress,egress,keyword,ingressNodes,egressNodes,canCreate,t,text,onMode,onStatus,onIngress,onEgress,onKeyword,onCreate}:{mode:ForwardModeFilter;status:ForwardStatusFilter;ingress:string;egress:string;keyword:string;ingressNodes:UserNode[];egressNodes:UserNode[];canCreate:boolean;t:Translate;text:Translate;onMode:(v:ForwardModeFilter)=>void;onStatus:(v:ForwardStatusFilter)=>void;onIngress:(v:string)=>void;onEgress:(v:string)=>void;onKeyword:(v:string)=>void;onCreate:(mode:"direct"|"relay")=>void}){return <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2">
 {(["all","direct","relay"] as const).map(v=><Button key={v} size="sm" variant={mode===v?"default":"outline"} onClick={()=>onMode(v)}>{t(v==="all"?"forward.all":`forward.${v}`)}</Button>)}
 <Input className="h-9 w-64" value={keyword} onChange={e=>onKeyword(e.target.value)} placeholder={t("forward.searchPlaceholder")} data-testid="forward-keyword"/>
 <Select value={status} onValueChange={v=>onStatus(v as ForwardStatusFilter)}><SelectTrigger className="h-9 w-40"><SelectValue/></SelectTrigger><SelectContent>
 {(["all","active","pending","applying","suspended","error"] as const).map(v=><SelectItem key={v} value={v}>{t(v==="all"?"forward.statusAll":v==="applying"?"tunnel.v3ApplyApplying":`forward.status${v[0].toUpperCase()+v.slice(1)}`)}</SelectItem>)}
 </SelectContent></Select>
 <Select value={ingress} onValueChange={onIngress}><SelectTrigger className="h-9 w-48"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">{t("forward.allIngress")}</SelectItem>{ingressNodes.map(n=><SelectItem key={String(n.id)} value={String(n.id)}>{n.node_id}</SelectItem>)}</SelectContent></Select>
 <Select value={egress} onValueChange={onEgress}><SelectTrigger className="h-9 w-48" data-testid="forward-egress-filter"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">{text("forward.allEgress")}</SelectItem>{egressNodes.map(n=><SelectItem key={String(n.id)} value={String(n.id)}>{n.node_id}</SelectItem>)}</SelectContent></Select>
 </div><div className="flex flex-wrap gap-2"><Button disabled={!canCreate} variant="outline" onClick={()=>onCreate("direct")}><Plus className="size-4"/>{t("forward.createDirect")}</Button><Button disabled={!canCreate} onClick={()=>onCreate("relay")}><Route className="size-4"/>{t("forward.createRelay")}</Button></div></div>}