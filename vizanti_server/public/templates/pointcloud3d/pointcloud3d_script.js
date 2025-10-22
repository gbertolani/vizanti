let tfModule = await import(`${base_url}/js/modules/tf.js`);
let rosbridgeModule = await import(`${base_url}/js/modules/rosbridge.js`);
let persistentModule = await import(`${base_url}/js/modules/persistent.js`);
let StatusModule = await import(`${base_url}/js/modules/status.js`);
let utilModule = await import(`${base_url}/js/modules/util.js`);
const THREE = await import('three');
const scene3dModule = await import(`${base_url}/js/modules/scene3d.js`);

const { applyRotation, tf } = tfModule;
const { rosbridge } = rosbridgeModule;
const settings = persistentModule.settings;
const Status = StatusModule.Status;

let topic = getTopic("{uniqueID}");
let status = new Status(
	document.getElementById("{uniqueID}_icon"),
	document.getElementById("{uniqueID}_status")
);

const selectionbox = document.getElementById("{uniqueID}_topic");
const iconWrapper = document.getElementById("{uniqueID}_icon");
const iconObject = iconWrapper.getElementsByTagName('object')[0];

const pointSizeSlider = document.getElementById('{uniqueID}_point_size');
const pointSizeValue = document.getElementById('{uniqueID}_point_size_value');
const colourPicker = document.getElementById('{uniqueID}_colorpicker');
const maxPointsInput = document.getElementById('{uniqueID}_max_points');
const throttleInput = document.getElementById('{uniqueID}_throttle');



const sceneHandle = await scene3dModule.acquireScene('{uniqueID}');
const { camera, controls, addLayer } = sceneHandle;

const pointLayer = addLayer('{uniqueID}_pointcloud');
pointLayer.rotation.x = -Math.PI / 2; // align cloud upright relative to camera

const pointMaterial = new THREE.PointsMaterial({
	size: parseFloat(pointSizeSlider.value),
	color: new THREE.Color(colourPicker.value),
	sizeAttenuation: false, // keep slider units in screen-space so clouds render as points
	depthWrite: false,
	transparent: true,
	vertexColors: false
});

const pointGeometry = new THREE.BufferGeometry();
pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
const pointMesh = new THREE.Points(pointGeometry, pointMaterial);
pointLayer.add(pointMesh);
let rosTopic = undefined;
let listener = undefined;
let rawPoints = new Float32Array();
let rawColors = new Float32Array();
let rawFrame = '';
let viewHasFitted = false;
const qosProfile = {
	reliability: 'best_effort',
	durability: 'volatile',
	history: 'keep_last',
	depth: 10
};

function saveSettings() {
	settings["{uniqueID}"] = {
		topic: topic,
		point_size: pointSizeSlider.value,
		color: colourPicker.value,
		max_points: maxPointsInput.value,
		throttle: throttleInput.value
	};
	settings.save();
}

function applySettingsToMaterial() {
	pointMaterial.size = parseFloat(pointSizeSlider.value);
	if (!pointMaterial.vertexColors) {
		pointMaterial.color.set(colourPicker.value);
	}
	pointMaterial.needsUpdate = true;
}

function updateIconColour() {
	utilModule.setIconColor(iconObject, colourPicker.value);
}

function bytes_to_datatype(view, offset, type, littleEndian) {
	switch (type) {
		case 1: return view.getInt8(offset);
		case 2: return view.getUint8(offset);
		case 3: return view.getInt16(offset, littleEndian);
		case 4: return view.getUint16(offset, littleEndian);
		case 5: return view.getInt32(offset, littleEndian);
		case 6: return view.getUint32(offset, littleEndian);
		case 7: return view.getFloat32(offset, littleEndian);
		case 8: return view.getFloat64(offset, littleEndian);
		default: return 0;
	}
}

function toDataView(msg) {
	let buffer;

	if (Array.isArray(msg.data)) {
		buffer = new ArrayBuffer(msg.data.length);
		const view = new Uint8Array(buffer);
		for (let i = 0; i < msg.data.length; i++) {
			view[i] = msg.data[i];
		}
	} else if (typeof msg.data === 'string') {
		const binary = atob(msg.data);
		buffer = new ArrayBuffer(binary.length);
		const bytes = new Uint8Array(buffer);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
	} else if (msg.data instanceof ArrayBuffer) {
		buffer = msg.data.slice(0);
	} else if (msg.data && ArrayBuffer.isView(msg.data)) {
		const view = new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength);
		buffer = new ArrayBuffer(view.length);
		new Uint8Array(buffer).set(view);
	} else {
		return { dataView: undefined, availablePoints: 0 };
	}

	const dataView = new DataView(buffer);
	const availablePoints = Math.floor(buffer.byteLength / msg.point_step);
	return { dataView, availablePoints };
}

function detectColorExtractor(fields) {
	const rgbField = fields.find(field => field.name === 'rgb' || field.name === 'rgba');
	if (rgbField) {
		return { type: 'rgb', field: rgbField };
	}

	const rField = fields.find(field => field.name === 'r');
	const gField = fields.find(field => field.name === 'g');
	const bField = fields.find(field => field.name === 'b');
	if (rField && gField && bField) {
		return { type: 'components', fields: { r: rField, g: gField, b: bField } };
	}

	return undefined;
}

function readFieldValue(view, offset, field, littleEndian) {
	return bytes_to_datatype(view, offset + field.offset, field.datatype, littleEndian);
}

// function decodeRGBValue(raw, hasAlpha) {
// 	const r = ((raw >> 16) & 0xff) / 255;
// 	const g = ((raw >> 8) & 0xff) / 255;
// 	const b = (raw & 0xff) / 255;
// 	const a = hasAlpha ? ((raw >> 24) & 0xff) / 255 : 1;
// 	return { r, g, b, a };
// }

function clamp01(value) {
	return Math.max(0, Math.min(1, value));
}

function normalizeColorComponent(value, field) {
	if (!Number.isFinite(value)) {
		return 0;
	}

	switch (field.datatype) {
		case 7: // float32
		case 8: // float64
			if (value > 1) {
				return clamp01(value / 255);
			}
			return clamp01(value);
		default:
			return clamp01(value / 255);
	}
}

function updateGeometry() {
	if (!rawPoints.length || rawFrame === '') {
		pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
		pointGeometry.deleteAttribute('color');
		pointMaterial.vertexColors = false;
		pointGeometry.boundingSphere = null;
		return;
	}

	const transform = tf.absoluteTransforms[rawFrame];
	if (!transform) {
		status.setError(`Required transform frame "${rawFrame}" not found.`);
		return;
	}

	const positions = new Float32Array(rawPoints.length);
	const count = rawPoints.length / 3;

	for (let i = 0; i < count; i++) {
		const idx = i * 3;
		const rotated = applyRotation({
			x: rawPoints[idx],
			y: rawPoints[idx + 1],
			z: rawPoints[idx + 2]
		}, transform.rotation, false);

		positions[idx] = rotated.x + transform.translation.x;
		positions[idx + 1] = rotated.y + transform.translation.y;
		positions[idx + 2] = rotated.z + transform.translation.z;
	}

	pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	pointGeometry.attributes.position.needsUpdate = true;

	if (rawColors.length === rawPoints.length) {
		pointGeometry.setAttribute('color', new THREE.BufferAttribute(rawColors, 3));
		pointGeometry.attributes.color.needsUpdate = true;
		pointMaterial.vertexColors = true;
		pointMaterial.color.setRGB(1, 1, 1);
	} else {
		pointGeometry.deleteAttribute('color');
		pointMaterial.vertexColors = false;
		pointMaterial.color.set(colourPicker.value);
	}
	pointMaterial.needsUpdate = true;

	pointGeometry.computeBoundingSphere();

	if (!viewHasFitted && pointGeometry.boundingSphere) {
		const { center, radius } = pointGeometry.boundingSphere;
		const distance = Math.max(radius * 2.5, 5);
		const offset = new THREE.Vector3(distance, distance, distance);
		controls.target.copy(center);
		camera.position.copy(center.clone().add(offset));
		controls.update();
		viewHasFitted = true;
	}
}

function handleMessage(msg) {
	let frameId = msg.header.frame_id || '';
	if (frameId === '') {
		status.setWarn("Transform frame is empty, falling back to fixed frame.");
		frameId = tf.fixed_frame;
	}

	const pose = tf.absoluteTransforms[frameId];
	if (!pose) {
		rawPoints = new Float32Array();
		rawColors = new Float32Array();
		rawFrame = '';
		updateGeometry();
		status.setError(`Required transform frame "${frameId}" not found.`);
		return;
	}

	const xField = msg.fields.find(field => field.name === 'x');
	const yField = msg.fields.find(field => field.name === 'y');
	const zField = msg.fields.find(field => field.name === 'z');

	if (!xField || !yField || !zField) {
		rawPoints = new Float32Array();
		rawColors = new Float32Array();
		rawFrame = frameId;
		updateGeometry();
		status.setError("XYZ coordinate data not found in cloud.");
		return;
	}

	const littleEndian = !msg.is_bigendian;
	const { dataView, availablePoints } = toDataView(msg);
	if (!dataView || availablePoints === 0) {
		rawPoints = new Float32Array();
		rawColors = new Float32Array();
		rawFrame = frameId;
		viewHasFitted = false;
		status.setWarn("Point cloud is empty or unsupported format.");
		updateGeometry();
		return;
	}

	const fallbackMax = parseInt(maxPointsInput.min || '1000', 10);
	const requestedMax = parseInt(maxPointsInput.value, 10);
	const maxPoints = Number.isFinite(requestedMax) ? requestedMax : fallbackMax;
	const desiredPoints = Math.max(1, Math.min(maxPoints, availablePoints));
	const stride = Math.max(1, Math.ceil(availablePoints / desiredPoints));
	const sampled = Math.min(desiredPoints, Math.ceil(availablePoints / stride));

	rawPoints = new Float32Array(sampled * 3);
	let localColors = undefined;
	const colorExtractor = detectColorExtractor(msg.fields);
	if (colorExtractor) {
		localColors = new Float32Array(sampled * 3);
	}
	let writeIndex = 0;
	let colorIndex = 0;

	for (let i = 0; i < availablePoints && writeIndex < rawPoints.length; i += stride) {
		const offset = i * msg.point_step;
		const x = bytes_to_datatype(dataView, offset + xField.offset, xField.datatype, littleEndian);
		const y = bytes_to_datatype(dataView, offset + yField.offset, yField.datatype, littleEndian);
		const z = bytes_to_datatype(dataView, offset + zField.offset, zField.datatype, littleEndian);

		rawPoints[writeIndex++] = x;
		rawPoints[writeIndex++] = y;
		rawPoints[writeIndex++] = z;

		if (localColors) {
			if (colorExtractor.type === 'rgb') {
				const field = colorExtractor.field;
				const b0 = dataView.getUint8(offset + field.offset + 0);
				const b1 = dataView.getUint8(offset + field.offset + 1);
				const b2 = dataView.getUint8(offset + field.offset + 2);

				let r;
				let g;
				let b;
				if (msg.is_bigendian) {
					r = b0;
					g = b1;
					b = b2;
				} else {
					b = b0;
					g = b1;
					r = b2;
				}

				localColors[colorIndex++] = r / 255;
				localColors[colorIndex++] = g / 255;
				localColors[colorIndex++] = b / 255;
			} else if (colorExtractor.type === 'components') {
				const components = colorExtractor.fields;
				const r = normalizeColorComponent(readFieldValue(dataView, offset, components.r, littleEndian), components.r);
				const g = normalizeColorComponent(readFieldValue(dataView, offset, components.g, littleEndian), components.g);
				const b = normalizeColorComponent(readFieldValue(dataView, offset, components.b, littleEndian), components.b);
				localColors[colorIndex++] = r;
				localColors[colorIndex++] = g;
				localColors[colorIndex++] = b;
			}
		}
	}

	const previousFrame = rawFrame;
	rawFrame = frameId;
	if (previousFrame !== frameId) {
		viewHasFitted = false;
	}
	rawColors = localColors ?? new Float32Array();
	status.setOK();
	updateGeometry();
	console.debug(`PointCloud3D (${topic}) received`, {
		availablePoints,
		sampledPoints: sampled,
		stride,
		hasColor: Boolean(localColors),
		frame: frameId
	});
}

function connect() {
	if (topic === "") {
		status.setError("Empty topic.");
		return;
	}

	if (rosTopic && listener) {
		rosTopic.unsubscribe(listener);
		listener = undefined;
	}

	rosTopic = new ROSLIB.Topic({
		ros: rosbridge.ros,
		name: topic,
		messageType: 'sensor_msgs/msg/PointCloud2',
		throttle_rate: parseInt(throttleInput.value),
		compression: rosbridge.compression,
		qos: qosProfile
	});

	status.setWarn("No data received yet.");

	listener = rosTopic.subscribe((msg) => {
		handleMessage(msg);
	});

	saveSettings();
}

async function loadTopics() {
	try {
		const topics = await rosbridge.get_topics('sensor_msgs/msg/PointCloud2');
		let options = "";
		topics.forEach((name) => {
			options += `<option value="${name}">${name}</option>`;
		});
		selectionbox.innerHTML = options;

		if (topic === "" && topics.length > 0) {
			topic = topics[0];
		} else if (topic !== "" && !topics.includes(topic)) {
			options += `<option value="${topic}">${topic}</option>`;
			selectionbox.innerHTML = options;
		}

		selectionbox.value = topic;
		connect();
	} catch (error) {
		status.setError('Unable to list PointCloud2 topics.');
		console.error(error);
	}
}

selectionbox.addEventListener('change', () => {
	topic = selectionbox.value;
	rawPoints = new Float32Array();
	rawColors = new Float32Array();
	rawFrame = '';
	viewHasFitted = false;
	updateGeometry();
	connect();
});
selectionbox.addEventListener('click', connect);

pointSizeSlider.addEventListener('input', () => {
	pointSizeValue.textContent = pointSizeSlider.value;
	applySettingsToMaterial();
	saveSettings();
});

colourPicker.addEventListener('input', () => {
	applySettingsToMaterial();
	updateIconColour();
	saveSettings();
});

maxPointsInput.addEventListener('change', () => {
	rawPoints = new Float32Array();
	rawColors = new Float32Array();
	viewHasFitted = false;
	saveSettings();
});

throttleInput.addEventListener('change', () => {
	saveSettings();
	connect();
});

window.addEventListener('tf_fixed_frame_changed', updateGeometry);
const removeHandler = (event) => {
	if (event.uniqueID === '{uniqueID}') {
		if (rosTopic && listener) {
			rosTopic.unsubscribe(listener);
			listener = undefined;
		}
		pointGeometry.dispose();
		pointMaterial.dispose();
		try {
			sceneHandle.removeLayer(pointLayer);
		} catch (error) {
			console.debug('Pointcloud layer removal failed', error);
		}
		scene3dModule.releaseScene('{uniqueID}');
		viewHasFitted = false;
		window.removeEventListener('remove_widget', removeHandler);
	}
};
window.addEventListener('remove_widget', removeHandler);

if (settings.hasOwnProperty("{uniqueID}")) {
	const stored = settings["{uniqueID}"];
	topic = stored.topic;
	pointSizeSlider.value = stored.point_size ?? pointSizeSlider.value;
	pointSizeValue.textContent = pointSizeSlider.value;
	colourPicker.value = stored.color ?? colourPicker.value;
	maxPointsInput.value = stored.max_points ?? maxPointsInput.value;
	throttleInput.value = stored.throttle ?? throttleInput.value;
} else {
	saveSettings();
}

pointSizeValue.textContent = pointSizeSlider.value;
updateIconColour();
applySettingsToMaterial();

iconObject?.addEventListener('load', updateIconColour);
if (iconObject?.contentDocument) {
	updateIconColour();
}

loadTopics();

console.log('Point Cloud 3D Widget Loaded {uniqueID}');
