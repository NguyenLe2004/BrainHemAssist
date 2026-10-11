"""Create the mixed-precision MatMul INT8 variant of the published Baseline S."""
import argparse
import copy
import hashlib
from pathlib import Path
import tempfile

SOURCE_SHA256 = "92bc39b59ba8edd9f59241baa0b6ebe707690d92257cccc32c5933dbdc282ee5"
ROOT = Path(__file__).resolve().parents[1]


def restore_fp32_gemm(source, model):
    """Preserve shared attention matrices across ORT's Gemm rewrite."""
    originals = {node.name: node for node in source.graph.node if node.op_type == "Gemm"}
    rewrites = {name + "_MatMul": node for name, node in originals.items()}
    additions = {name + "_Add" for name, node in originals.items() if len(node.input) == 3}
    restored = set()
    nodes = []
    for node in model.graph.node:
        if node.name in rewrites:
            original = rewrites[node.name]
            nodes.append(copy.deepcopy(original))
            restored.add(original.name)
        elif node.name not in additions:
            nodes.append(node)
    if restored != set(originals):
        raise RuntimeError("Unexpected FP32 attention rewrite")
    # ORT transposes a shared Gemm initializer once per use. Restore the exact
    # original matrix and transB operation instead of relying on that rewrite.
    names = {node.input[1] for node in originals.values()}
    weights = {tensor.name: tensor for tensor in source.graph.initializer if tensor.name in names}
    if set(weights) != names:
        raise RuntimeError("An attention matrix is missing from the approved source")
    present = {tensor.name for tensor in model.graph.initializer}
    tensors = [copy.deepcopy(weights.get(tensor.name, tensor)) for tensor in model.graph.initializer]
    tensors.extend(copy.deepcopy(tensor) for tensor in source.graph.initializer if tensor.name in names - present)
    del model.graph.node[:]
    model.graph.node.extend(nodes)
    del model.graph.initializer[:]
    model.graph.initializer.extend(tensors)


def order_with_captures(graph):
    """Keep lexical dependencies before control-flow nodes after ORT rewriting."""
    import onnx

    def children(node):
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                yield attr.g
            elif attr.type == onnx.AttributeProto.GRAPHS:
                yield from attr.graphs

    dependencies = []
    for node in graph.node:
        required = set(filter(None, node.input))
        for child in children(node):
            required.update(order_with_captures(child))
        dependencies.append(required)
    local = {item.name for item in graph.input} | {item.name for item in graph.initializer}
    produced = {name for node in graph.node for name in node.output if name}
    free = (set().union(*dependencies, {item.name for item in graph.output}) - local - produced)
    available = local | free
    pending = list(zip(graph.node, dependencies))
    ordered = []
    while pending:
        remaining = []
        for node, required in pending:
            if required <= available:
                ordered.append(node)
                available.update(filter(None, node.output))
            else:
                remaining.append((node, required))
        if len(remaining) == len(pending):
            raise RuntimeError("Cannot resolve control-flow dependencies")
        pending = remaining
    del graph.node[:]
    graph.node.extend(ordered)
    return free


def main():
    import onnx
    import onnxruntime
    import numpy
    from onnxruntime.quantization import QuantType, quantize_dynamic

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "models/baseline_s.onnx")
    parser.add_argument("--output", type=Path, default=ROOT / "models/baseline_s.int8.onnx")
    args = parser.parse_args()
    if args.input.is_symlink() or not args.input.is_file():
        parser.error("Input must be the regular published Baseline S artifact")
    if hashlib.sha256(args.input.read_bytes()).hexdigest() != SOURCE_SHA256:
        parser.error("Input does not match the published Baseline S artifact")
    if args.input.resolve() == args.output.resolve():
        parser.error("Output must not overwrite the FP32 model")
    if args.output.exists() or args.output.is_symlink():
        parser.error("Output already exists; choose a new path")
    if onnxruntime.__version__ != "1.30.0" or onnx.__version__ != "1.23.2" or numpy.__version__ != "1.26.4":
        parser.error("Use requirements-quantization.txt for the reproducible conversion")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source = onnx.load(args.input)
    selected = [node.name for node in source.graph.node if node.op_type == "MatMul"]
    with tempfile.TemporaryDirectory(prefix="brainhem-quant-", dir=args.output.parent) as staging:
        staged = Path(staging) / "model.onnx"
        quantize_dynamic(
            str(args.input), str(staged),
            op_types_to_quantize=["MatMul"],
            nodes_to_quantize=selected,
            weight_type=QuantType.QInt8,
            per_channel=False,
            reduce_range=True,
            use_external_data_format=False,
            extra_options={
                "EnableSubgraph": False,
                "MatMulConstBOnly": True,
                # This approved graph's MatMul activations are float32, including
                # outputs reached through recurrent control flow.
                "DefaultTensorType": onnx.TensorProto.FLOAT,
            },
        )
        model = onnx.load(staged)
        restore_fp32_gemm(source, model)
        # ORT sorts direct inputs but can move a captured tensor after an If node.
        # Reorder only: preserve every tensor/operator and all recurrent subgraphs.
        if order_with_captures(model.graph):
            raise RuntimeError("Quantized model contains unresolved graph inputs")
        onnx.checker.check_model(model)
        count = sum(node.op_type == "MatMulInteger" for node in model.graph.node)
        if count != 12:
            raise RuntimeError(f"Expected 12 quantized MatMul operations, found {count}")
        onnx.save(model, staged)
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        onnxruntime.InferenceSession(str(staged), sess_options=options, providers=["CPUExecutionProvider"])
        # Exclusive creation also protects against overwriting a concurrent output.
        with args.output.open("xb") as output:
            output.write(staged.read_bytes())
    print(f"Wrote {args.output.name}: {args.output.stat().st_size:,} bytes; {count} INT8 MatMul operations")
    print("Conv and recurrent context remain FP32; this is a mixed-precision model.")


if __name__ == "__main__":
    main()
