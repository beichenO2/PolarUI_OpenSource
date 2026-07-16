import type { ProductManifest } from '@polar/native-web-product-sdk';
import { ArtifactPanel } from '../assets/ArtifactPanel';
const descriptions: Record<ProductManifest['stages'][number]['component_key'], { title: string; description: string }> = {
  generic_chat: { title: '当前任务', description: '整理本阶段的关键信息与决定。' },
  structured_form: { title: '信息整理', description: '完成本阶段需要确认的信息。' },
  card_selection: { title: '方案选择', description: '比较候选项并作出选择。' },
  document_workspace: { title: '工作文档', description: '整理材料并完善当前方案。' },
};
export function StageWorkspace({ componentKey, routeId, stageKey, revision = 0 }: {
  componentKey: ProductManifest['stages'][number]['component_key'];
  routeId: string;
  stageKey: string;
  revision?: number;
}) {
  const definition = descriptions[componentKey]; return <section className={`stage-component stage-component-${componentKey}`} data-component-key={componentKey}>
    <div className="stage-component-intro"><h2>{definition.title}</h2><p>{definition.description}</p></div>
    {componentKey === 'structured_form' && <dl className="structured-summary"><div><dt>材料</dt><dd>讨论与附件</dd></div><div><dt>目标</dt><dd>形成明确结论</dd></div></dl>}
    {componentKey === 'card_selection' && <div className="selection-placeholder" role="note">暂无候选项</div>}
    <ArtifactPanel routeId={routeId} stageKey={stageKey} revision={revision} />
  </section>;
}
