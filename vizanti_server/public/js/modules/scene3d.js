const THREE = await import('three');
const ControlsModule = await import(`${base_url}/js/lib/OrbitControls.js`);
const { OrbitControls } = ControlsModule;

const sharedContext = {
	container: null,
	renderer: null,
	scene: null,
	camera: null,
	controls: null,
	worldGroup: null,
	labelRoot: null,
	clients: new Map(),
	animationId: null,
	rotationState: {
		active: false,
		pointerId: null,
		lastX: 0,
		lastY: 0
	},
	rotationSpeed: 0.005,
	resizeHandler: null,
	orientationHandler: null,
	pointerDownHandler: null,
	pointerMoveHandler: null,
	pointerUpHandler: null,
	generalHandler: null,
	generalEvents: ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'touchstart', 'touchmove', 'touchend'],
	frameCallbacks: new Map()
};

function ensureDOMContainer() {
	const viewContainer = document.getElementById('view_container');
	const parent = viewContainer ?? document.body;

	const container = document.createElement('div');
	container.id = 'vizanti_scene3d_root';
	container.classList.add('scene3d-root');
	parent.appendChild(container);
	return container;
}

function ensureRenderer() {
	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.domElement.id = 'vizanti_scene3d_canvas';
	renderer.domElement.style.touchAction = 'none';
	return renderer;
}

function setupScene() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x000000);
	return scene;
}

function setupCamera() {
	const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
	camera.position.set(10, 10, 10);
	return camera;
}

function setupControls(camera, domElement) {
	const controls = new OrbitControls(camera, domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.1;
	controls.enableRotate = false;
	controls.screenSpacePanning = true;
	controls.target.set(0, 0, 0);
	controls.update();
	return controls;
}

function setupWorldGroup(scene) {
	const group = new THREE.Group();
	group.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));
	group.add(new THREE.AxesHelper(1));
	scene.add(group);
	return group;
}

function ensureLabelRoot(container) {
	const labelRoot = document.createElement('div');
	labelRoot.classList.add('scene3d-label-root');
	container.appendChild(labelRoot);
	return labelRoot;
}

function isPrimaryPointer(event) {
	if (event.pointerType === 'mouse') {
		return event.button === 0;
	}
	return event.isPrimary !== false;
}

function startManualRotation(event) {
	if (!isPrimaryPointer(event) || sharedContext.rotationState.active) {
		return;
	}
	sharedContext.rotationState.active = true;
	sharedContext.rotationState.pointerId = event.pointerId;
	sharedContext.rotationState.lastX = event.clientX;
	sharedContext.rotationState.lastY = event.clientY;
	try {
		sharedContext.renderer.domElement.setPointerCapture(event.pointerId);
	} catch (error) {
		console.debug('Pointer capture unavailable', error);
	}
}

function applyManualRotation(event) {
	if (!sharedContext.rotationState.active || event.pointerId !== sharedContext.rotationState.pointerId) {
		return;
	}
	const deltaX = event.clientX - sharedContext.rotationState.lastX;
	const deltaY = event.clientY - sharedContext.rotationState.lastY;
	sharedContext.rotationState.lastX = event.clientX;
	sharedContext.rotationState.lastY = event.clientY;

	sharedContext.worldGroup.rotation.z -= deltaX * sharedContext.rotationSpeed;
	sharedContext.worldGroup.rotation.x += deltaY * sharedContext.rotationSpeed;
	const maxTilt = Math.PI / 3;
	sharedContext.worldGroup.rotation.x = Math.max(-maxTilt, Math.min(maxTilt, sharedContext.worldGroup.rotation.x));
}

function stopManualRotation(event) {
	if (!sharedContext.rotationState.active || event.pointerId !== sharedContext.rotationState.pointerId) {
		return;
	}
	sharedContext.rotationState.active = false;
	sharedContext.rotationState.pointerId = null;
	try {
		sharedContext.renderer.domElement.releasePointerCapture(event.pointerId);
	} catch (error) {
		console.debug('Pointer release unavailable', error);
	}
}

function attachEventHandlers() {
	if (!sharedContext.renderer || sharedContext.pointerDownHandler) {
		return;
	}

	sharedContext.generalHandler = (event) => {
		event.stopPropagation();
		if (event.type === 'wheel') {
			event.preventDefault();
		}
	};

	sharedContext.generalEvents.forEach((eventName) => {
		const passive = eventName === 'wheel' || eventName.startsWith('touch') ? false : true;
		const options = eventName === 'wheel' || eventName.startsWith('touch') ? { passive } : passive;
		sharedContext.renderer.domElement.addEventListener(eventName, sharedContext.generalHandler, options);
	});

	sharedContext.pointerDownHandler = (event) => {
		if (!isPrimaryPointer(event)) {
			return;
		}
		event.preventDefault();
		startManualRotation(event);
	};
	sharedContext.pointerMoveHandler = (event) => {
		applyManualRotation(event);
	};
	sharedContext.pointerUpHandler = (event) => {
		stopManualRotation(event);
	};

	sharedContext.renderer.domElement.addEventListener('pointerdown', sharedContext.pointerDownHandler);
	sharedContext.renderer.domElement.addEventListener('pointermove', sharedContext.pointerMoveHandler);
	['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
		sharedContext.renderer.domElement.addEventListener(eventName, sharedContext.pointerUpHandler);
	});

	sharedContext.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());

	sharedContext.resizeHandler = () => {
		if (!sharedContext.renderer || !sharedContext.camera) {
			return;
		}
		const width = window.innerWidth;
		const height = window.innerHeight;
		sharedContext.renderer.setSize(width, height);
		sharedContext.camera.aspect = width / height;
		sharedContext.camera.updateProjectionMatrix();

		sharedContext.clients.forEach((client) => {
			client.resizeCallbacks.forEach((callback) => {
				try {
					callback();
				} catch (error) {
					console.error('3D scene resize callback failed', error);
				}
			});
		});
	};

	sharedContext.orientationHandler = sharedContext.resizeHandler;

	window.addEventListener('resize', sharedContext.resizeHandler);
	window.addEventListener('orientationchange', sharedContext.orientationHandler);
}

function detachEventHandlers() {
	if (!sharedContext.renderer) {
		return;
	}

	if (sharedContext.generalHandler) {
		sharedContext.generalEvents.forEach((eventName) => {
			sharedContext.renderer.domElement.removeEventListener(eventName, sharedContext.generalHandler);
		});
		sharedContext.generalHandler = null;
	}

	if (sharedContext.pointerDownHandler) {
		sharedContext.renderer.domElement.removeEventListener('pointerdown', sharedContext.pointerDownHandler);
		sharedContext.pointerDownHandler = null;
	}
	if (sharedContext.pointerMoveHandler) {
		sharedContext.renderer.domElement.removeEventListener('pointermove', sharedContext.pointerMoveHandler);
		sharedContext.pointerMoveHandler = null;
	}
	if (sharedContext.pointerUpHandler) {
		['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
			sharedContext.renderer.domElement.removeEventListener(eventName, sharedContext.pointerUpHandler);
		});
		sharedContext.pointerUpHandler = null;
	}

	if (sharedContext.resizeHandler) {
		window.removeEventListener('resize', sharedContext.resizeHandler);
		sharedContext.resizeHandler = null;
	}
	if (sharedContext.orientationHandler) {
		window.removeEventListener('orientationchange', sharedContext.orientationHandler);
		sharedContext.orientationHandler = null;
	}
}

function startAnimationLoop() {
	if (sharedContext.animationId !== null) {
		return;
	}

	const animate = () => {
		if (!sharedContext.renderer || !sharedContext.scene || !sharedContext.camera) {
			sharedContext.animationId = null;
			return;
		}

		sharedContext.controls?.update();
		sharedContext.renderer.render(sharedContext.scene, sharedContext.camera);

		sharedContext.clients.forEach((client) => {
			client.frameCallbacks.forEach((callback) => {
				try {
					callback();
				} catch (error) {
					console.error('3D scene frame callback failed', error);
				}
			});
		});

		sharedContext.animationId = requestAnimationFrame(animate);
	};

	sharedContext.animationId = requestAnimationFrame(animate);
}

function stopAnimationLoop() {
	if (sharedContext.animationId !== null) {
		cancelAnimationFrame(sharedContext.animationId);
		sharedContext.animationId = null;
	}
}

function ensureInitialized() {
	if (sharedContext.renderer) {
		return;
	}

	sharedContext.container = ensureDOMContainer();
	sharedContext.renderer = ensureRenderer();
	sharedContext.container.appendChild(sharedContext.renderer.domElement);

	sharedContext.labelRoot = ensureLabelRoot(sharedContext.container);
	sharedContext.scene = setupScene();
	sharedContext.camera = setupCamera();
	sharedContext.controls = setupControls(sharedContext.camera, sharedContext.renderer.domElement);
	sharedContext.worldGroup = setupWorldGroup(sharedContext.scene);

	attachEventHandlers();
	startAnimationLoop();
}

function addLayerForWidget(widgetId, name = '') {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		throw new Error(`3D scene client ${widgetId} not registered`);
	}
	const group = new THREE.Group();
	if (name) {
		group.name = name;
	}
	sharedContext.worldGroup.add(group);
	client.layers.push(group);
	return group;
}

function removeLayerForWidget(widgetId, layer) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		return;
	}
	const index = client.layers.indexOf(layer);
	if (index !== -1) {
		client.layers.splice(index, 1);
	}
	if (layer.parent) {
		layer.parent.remove(layer);
	}
}

function createLabelLayer(widgetId) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		throw new Error(`3D scene client ${widgetId} not registered`);
	}
	const layer = document.createElement('div');
	layer.classList.add('scene3d-label-layer');
	sharedContext.labelRoot.appendChild(layer);
	client.labelLayers.push(layer);
	return layer;
}

function registerFrameCallback(widgetId, callback) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		throw new Error(`3D scene client ${widgetId} not registered`);
	}
	client.frameCallbacks.add(callback);
}

function unregisterFrameCallback(widgetId, callback) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		return;
	}
	client.frameCallbacks.delete(callback);
}

function registerResizeCallback(widgetId, callback) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		throw new Error(`3D scene client ${widgetId} not registered`);
	}
	client.resizeCallbacks.add(callback);
}

function unregisterResizeCallback(widgetId, callback) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		return;
	}
	client.resizeCallbacks.delete(callback);
}

export async function acquireScene(widgetId) {
	if (sharedContext.clients.has(widgetId)) {
		return createHandle(widgetId);
	}

	ensureInitialized();

	sharedContext.clients.set(widgetId, {
		layers: [],
		labelLayers: [],
		frameCallbacks: new Set(),
		resizeCallbacks: new Set()
	});

	return createHandle(widgetId);
}

function createHandle(widgetId) {
	return {
		renderer: sharedContext.renderer,
		scene: sharedContext.scene,
		camera: sharedContext.camera,
		controls: sharedContext.controls,
		worldGroup: sharedContext.worldGroup,
		addLayer: (name) => addLayerForWidget(widgetId, name),
		removeLayer: (layer) => removeLayerForWidget(widgetId, layer),
		createLabelLayer: () => createLabelLayer(widgetId),
		registerFrameCallback: (callback) => registerFrameCallback(widgetId, callback),
		unregisterFrameCallback: (callback) => unregisterFrameCallback(widgetId, callback),
		registerResizeCallback: (callback) => registerResizeCallback(widgetId, callback),
		unregisterResizeCallback: (callback) => unregisterResizeCallback(widgetId, callback)
	};
}

export function releaseScene(widgetId) {
	const client = sharedContext.clients.get(widgetId);
	if (!client) {
		return;
	}

	client.layers.forEach((layer) => {
		if (layer.parent) {
			layer.parent.remove(layer);
		}
	});
	client.layers.length = 0;

	client.labelLayers.forEach((layer) => {
		layer.remove();
	});
	client.labelLayers.length = 0;

	client.frameCallbacks.clear();
	client.resizeCallbacks.clear();

	sharedContext.clients.delete(widgetId);

	if (sharedContext.clients.size === 0) {
		stopAnimationLoop();
		detachEventHandlers();

		sharedContext.worldGroup?.parent?.remove(sharedContext.worldGroup);
		sharedContext.worldGroup = null;

		sharedContext.controls?.dispose?.();
		sharedContext.controls = null;

		sharedContext.renderer?.dispose?.();
		sharedContext.renderer?.domElement?.remove();
		sharedContext.renderer = null;

		sharedContext.labelRoot?.remove();
		sharedContext.labelRoot = null;

		sharedContext.scene = null;
		sharedContext.camera = null;

		sharedContext.container?.remove();
		sharedContext.container = null;

		sharedContext.rotationState.active = false;
		sharedContext.rotationState.pointerId = null;
	}
}

export function getWorldGroup() {
	return sharedContext.worldGroup;
}
