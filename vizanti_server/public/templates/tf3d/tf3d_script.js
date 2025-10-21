let tfModule = await import(`${base_url}/js/modules/tf.js`);
let persistentModule = await import(`${base_url}/js/modules/persistent.js`);
let StatusModule = await import(`${base_url}/js/modules/status.js`);
let utilModule = await import(`${base_url}/js/modules/util.js`);
const THREE = await import('three');
const scene3dModule = await import(`${base_url}/js/modules/scene3d.js`);

const { tf } = tfModule;
const settings = persistentModule.settings;
const Status = StatusModule.Status;

const iconWrapper = document.getElementById('{uniqueID}_icon');
const status = new Status(
	iconWrapper,
	document.getElementById('{uniqueID}_status')
);
status.setWarn('No TF data received yet.');

const namesCheckbox = document.getElementById('{uniqueID}_shownames');
const axesCheckbox = document.getElementById('{uniqueID}_showaxes');
const linesCheckbox = document.getElementById('{uniqueID}_showlines');
const scaleSlider = document.getElementById('{uniqueID}_scale');
const scaleSliderValue = document.getElementById('{uniqueID}_scale_value');

const framesDiv = document.getElementById('{uniqueID}_frames');
const icon = iconWrapper.getElementsByTagName('img')[0];

const sceneHandle = await scene3dModule.acquireScene('{uniqueID}');
const {
	renderer,
	camera,
	controls,
	addLayer,
	removeLayer,
	createLabelLayer,
	registerFrameCallback,
	unregisterFrameCallback,
	registerResizeCallback,
	unregisterResizeCallback
} = sceneHandle;

const framesGroup = addLayer('{uniqueID}_tf');
framesGroup.rotation.x = -Math.PI / 2;

const lineMaterial = new THREE.LineBasicMaterial({ color: 0xeba834, transparent: true, opacity: 0.8 });
const lineGeometry = new THREE.BufferGeometry();
const lineSegments = new THREE.LineSegments(lineGeometry, lineMaterial);
framesGroup.add(lineSegments);

const labelContainer = createLabelLayer();

const originGeometry = new THREE.SphereGeometry(0.05, 12, 12);
const originMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

const frameObjects = new Map();
const visibleRelativeKeys = new Set();
const visibleAbsoluteKeys = new Set();

let prevTransforms = new Set();
let groupedFrames = [];
let frame_visibility = {};
let viewHasFitted = false;

function saveSettings() {
	settings['{uniqueID}'] = {
		show_names: namesCheckbox.checked,
		show_axes: axesCheckbox.checked,
		show_lines: linesCheckbox.checked,
		scale: parseFloat(scaleSlider.value),
		frame_visibility: frame_visibility
	};
	settings.save();
}

if (settings.hasOwnProperty('{uniqueID}')) {
	const stored = settings['{uniqueID}'];
	namesCheckbox.checked = stored.show_names ?? true;
	axesCheckbox.checked = stored.show_axes ?? true;
	linesCheckbox.checked = stored.show_lines ?? true;
	scaleSlider.value = stored.scale ?? scaleSlider.value;
	scaleSliderValue.textContent = scaleSlider.value;
	frame_visibility = stored.frame_visibility ?? {};
} else {
	saveSettings();
	scaleSliderValue.textContent = scaleSlider.value;
}

function ensureFrameVisibilityKey(key) {
	if (!frame_visibility.hasOwnProperty(key)) {
		frame_visibility[key] = true;
	}
}

function updateVisibility() {
	visibleRelativeKeys.clear();
	visibleAbsoluteKeys.clear();

	Object.keys(tf.transforms).forEach((child) => {
		const parent = tf.transforms[child].parent;
		ensureFrameVisibilityKey(child);
		if (parent !== undefined) {
			ensureFrameVisibilityKey(parent);
		}

		if (frame_visibility[child]) {
			visibleRelativeKeys.add(child);
			if (tf.absoluteTransforms.hasOwnProperty(child)) {
				visibleAbsoluteKeys.add(child);
			}
		}
		if (frame_visibility[parent]) {
			visibleRelativeKeys.add(parent);
			if (tf.absoluteTransforms.hasOwnProperty(parent)) {
				visibleAbsoluteKeys.add(parent);
			}
		}
	});

	Object.keys(tf.absoluteTransforms).forEach((frame) => {
		ensureFrameVisibilityKey(frame);
		if (frame_visibility[frame]) {
			visibleAbsoluteKeys.add(frame);
		}
	});
}

function ensureFrameObject(key) {
	let entry = frameObjects.get(key);
	if (entry) {
		return entry;
	}

	const group = new THREE.Group();
	const origin = new THREE.Mesh(originGeometry, originMaterial.clone());
	group.add(origin);

	const axes = new THREE.AxesHelper(1);
	axes.visible = false;
	group.add(axes);

	framesGroup.add(group);

	const label = document.createElement('div');
	label.classList.add('scene3d-label');
	label.textContent = key;
	label.style.display = 'none';
	label.style.visibility = 'hidden';
	labelContainer.appendChild(label);

	entry = { group, origin, axes, label };
	frameObjects.set(key, entry);
	return entry;
}

const tempVec = new THREE.Vector3();
const tempBox = new THREE.Box3();
const tempCenter = new THREE.Vector3();
const tempSize = new THREE.Vector3();

function fitView(points) {
	if (points.length === 0) {
		return;
	}
	tempBox.makeEmpty();
	points.forEach((point) => {
		tempBox.expandByPoint(point);
	});
	tempBox.getCenter(tempCenter);
	tempBox.getSize(tempSize);
	const radius = Math.max(tempSize.length() * 0.5, 1.5);
	const offset = new THREE.Vector3(radius, radius, radius);

	const worldCenter = tempCenter.clone();
	framesGroup.localToWorld(worldCenter);

	controls.target.copy(worldCenter);
	camera.position.copy(worldCenter.clone().add(offset));
	controls.update();
}

function refreshScene() {
	updateVisibility();

	const relative = Object.fromEntries(
		[...visibleRelativeKeys].map((key) => [key, tf.transforms[key]]).filter(([, value]) => value)
	);
	const absolute = Object.fromEntries(
		[...visibleAbsoluteKeys].map((key) => [key, tf.absoluteTransforms[key]]).filter(([, value]) => value)
	);

	const scaleValue = parseFloat(scaleSlider.value);
	const axesScale = scaleValue;
	const originScale = Math.max(0.02, scaleValue * 0.06);
	const positionsForFit = [];
	const framesSeen = new Set();
	const linePositions = [];

	Object.keys(absolute).forEach((key) => {
		const transform = absolute[key];
		if (!transform) {
			return;
		}
		const entry = ensureFrameObject(key);
		const enabled = frame_visibility[key] !== false;

		framesSeen.add(key);
		entry.group.visible = enabled;
		entry.origin.visible = enabled;
		entry.axes.visible = axesCheckbox.checked && enabled;
		entry.axes.scale.set(axesScale, axesScale, axesScale);
		entry.origin.scale.set(originScale, originScale, originScale);
		entry.group.position.set(transform.translation.x, transform.translation.y, transform.translation.z);
		entry.group.quaternion.set(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);

		entry.label.textContent = key;
		if (namesCheckbox.checked && enabled) {
			entry.label.style.display = 'block';
		} else {
			entry.label.style.display = 'none';
		}
		entry.label.style.visibility = 'hidden';

		if (enabled) {
			positionsForFit.push(entry.group.position.clone());
		}
	});

	frameObjects.forEach((entry, key) => {
		if (!framesSeen.has(key)) {
			entry.group.visible = false;
			entry.label.style.display = 'none';
			entry.label.style.visibility = 'hidden';
		}
	});

	if (linesCheckbox.checked) {
		Object.keys(relative).forEach((child) => {
			const rel = relative[child];
			if (!rel) {
				return;
			}
			const parent = rel.parent;
			if (!parent) {
				return;
			}

			if (frame_visibility[child] === false || frame_visibility[parent] === false) {
				return;
			}

			const childTransform = absolute[child];
			const parentTransform = absolute[parent];
			if (!childTransform || !parentTransform) {
				return;
			}

			linePositions.push(
				childTransform.translation.x, childTransform.translation.y, childTransform.translation.z,
				parentTransform.translation.x, parentTransform.translation.y, parentTransform.translation.z
			);
		});

		if (linePositions.length > 0) {
			lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
			lineGeometry.computeBoundingSphere();
			lineMaterial.visible = true;
		} else {
			lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
			lineMaterial.visible = false;
		}
	} else {
		lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
		lineMaterial.visible = false;
	}

	if (!viewHasFitted && positionsForFit.length > 0) {
		fitView(positionsForFit);
		viewHasFitted = true;
	}

	if (framesSeen.size > 0) {
		status.setOK();
	} else {
		status.setWarn('No TF frames available.');
	}

	updateLabelPositions();
}

function updateLabelPositions() {
	const width = renderer.domElement.clientWidth;
	const height = renderer.domElement.clientHeight;

	frameObjects.forEach((entry) => {
		if (entry.label.style.display === 'none' || !entry.group.visible) {
			entry.label.style.visibility = 'hidden';
			return;
		}

		entry.group.getWorldPosition(tempVec);
		tempVec.project(camera);

		if (tempVec.z < -1 || tempVec.z > 1) {
			entry.label.style.visibility = 'hidden';
			return;
		}

		const x = (tempVec.x * 0.5 + 0.5) * width;
		const y = (-tempVec.y * 0.5 + 0.5) * height;
		entry.label.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
		entry.label.style.visibility = 'visible';
	});
}

function updateGUI() {
	updateVisibility();

	const eqSet = (xs, ys) => xs.size === ys.size && [...xs].every((x) => ys.has(x));
	let currentTransforms = new Set();
	Object.keys(tf.transforms).forEach((child) => {
		currentTransforms.add(child);
		currentTransforms.add(tf.transforms[child].parent);
	});
	Object.keys(tf.absoluteTransforms).forEach((frame) => {
		currentTransforms.add(frame);
	});

	if (!eqSet(prevTransforms, currentTransforms)) {
		groupedFrames = utilModule.groupStringsByPrefix(Array.from(currentTransforms), 2);
		prevTransforms = currentTransforms;
	}

	function getEntry(key) {
		ensureFrameVisibilityKey(key);
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.id = `{uniqueID}_${key}`;
		checkbox.checked = frame_visibility[key];
		checkbox.addEventListener('change', (event) => {
			frame_visibility[key] = event.target.checked;
			saveSettings();
			viewHasFitted = false;
			refreshScene();
		});

		const label = document.createElement('label');
		label.textContent = ` ${key}`;

		const div = document.createElement('div');
		div.classList.add('tf_label');
		div.appendChild(checkbox);
		div.appendChild(label);
		return div;
	}

	framesDiv.innerHTML = '';
	for (let i = 0; i < groupedFrames.length; i++) {
		const elements = groupedFrames[i];
		if (elements.length === 1) {
			framesDiv.appendChild(getEntry(elements[0]));
		} else {
			const detailsElement = document.createElement('details');
			detailsElement.setAttribute('open', 'open');
			detailsElement.classList.add('tf_details');

			const summaryElement = document.createElement('summary');
			summaryElement.classList.add('tf_summary');
			summaryElement.textContent = elements[0].replace(/_+$/, '');

			detailsElement.appendChild(summaryElement);
			detailsElement.appendChild(document.createElement('br'));
			for (let j = 1; j < elements.length; j++) {
				detailsElement.appendChild(getEntry(elements[j]));
				detailsElement.appendChild(document.createElement('br'));
			}
			framesDiv.appendChild(detailsElement);
		}
		framesDiv.appendChild(document.createElement('br'));
	}
}

namesCheckbox.addEventListener('change', () => {
	saveSettings();
	refreshScene();
});
axesCheckbox.addEventListener('change', () => {
	saveSettings();
	refreshScene();
});
linesCheckbox.addEventListener('change', () => {
	saveSettings();
	refreshScene();
});

scaleSlider.addEventListener('input', () => {
	scaleSliderValue.textContent = scaleSlider.value;
	refreshScene();
});
scaleSlider.addEventListener('change', () => {
	saveSettings();
});

icon.addEventListener('click', updateGUI);

const enableAllButton = document.getElementById('{uniqueID}_enable_all');
const standardOnlyButton = document.getElementById('{uniqueID}_standard_only');
const disableAllButton = document.getElementById('{uniqueID}_disable_all');

enableAllButton.addEventListener('click', () => {
	Object.keys(frame_visibility).forEach((key) => {
		frame_visibility[key] = true;
	});
	saveSettings();
	updateGUI();
	viewHasFitted = false;
	refreshScene();
});

standardOnlyButton.addEventListener('click', () => {
	const standardFrames = ['world', 'earth', 'map', 'odom', 'base_link', 'base_footprint', 'laser', 'base_stabilized'];
	const hasStandardFrame = (str) => standardFrames.some((frame) => str.includes(frame));

	Object.keys(frame_visibility).forEach((key) => {
		frame_visibility[key] = hasStandardFrame(key);
	});
	saveSettings();
	updateGUI();
	viewHasFitted = false;
	refreshScene();
});

disableAllButton.addEventListener('click', () => {
	Object.keys(frame_visibility).forEach((key) => {
		frame_visibility[key] = false;
	});
	saveSettings();
	updateGUI();
	viewHasFitted = false;
	refreshScene();
});

window.addEventListener('tf_changed', () => {
	refreshScene();
});

window.addEventListener('tf_fixed_frame_changed', () => {
	viewHasFitted = false;
	refreshScene();
});

const removeHandler = (event) => {
	if (event.uniqueID === '{uniqueID}') {
		unregisterFrameCallback(updateLabelPositions);
		unregisterResizeCallback(updateLabelPositions);
		lineGeometry.dispose();
		lineMaterial.dispose();
		originGeometry.dispose();
		originMaterial.dispose();
		frameObjects.forEach((entry) => {
			entry.group.parent?.remove(entry.group);
			entry.origin.material?.dispose?.();
			entry.axes.material?.dispose?.();
			entry.label.remove();
		});
		frameObjects.clear();
		try {
			removeLayer(framesGroup);
		} catch (error) {
			console.debug('TF3D layer removal failed', error);
		}
		labelContainer.remove();
		scene3dModule.releaseScene('{uniqueID}');
		window.removeEventListener('remove_widget', removeHandler);
	}
};
window.addEventListener('remove_widget', removeHandler);

registerFrameCallback(updateLabelPositions);
registerResizeCallback(updateLabelPositions);

refreshScene();

console.log('TF 3D Widget Loaded {uniqueID}');
