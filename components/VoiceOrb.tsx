
import React, { useRef } from 'react';
import { Canvas, useFrame, ThreeElements } from '@react-three/fiber';
import { Sphere, MeshDistortMaterial, Float, Environment, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';

// Fix: Use declare global to extend the JSX namespace for Three.js elements,
// resolving the issue where 'react' module augmentation was not being found.
declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

const OrbInner: React.FC<{ isSpeaking: boolean; isListening: boolean; isProcessing: boolean }> = ({ isSpeaking, isListening, isProcessing }) => {
  const materialRef = useRef<any>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);
  
  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    
    if (materialRef.current) {
      // Dynamic distortion based on state
      let targetDistort = 0.2;
      let targetSpeed = 1.5;

      if (isSpeaking) {
        targetDistort = 0.8;
        targetSpeed = 6;
      } else if (isProcessing) {
        targetDistort = 1.2;
        targetSpeed = 12; // Fast, frantic distortion for processing
      } else if (isListening) {
        targetDistort = 0.4;
        targetSpeed = 3;
      }
      
      materialRef.current.distort = THREE.MathUtils.lerp(materialRef.current.distort, targetDistort, 0.08);
      materialRef.current.speed = THREE.MathUtils.lerp(materialRef.current.speed, targetSpeed, 0.08);
    }

    if (meshRef.current) {
      // World-class "Breath" and "Response" physics
      if (isSpeaking) {
        const volumeScale = 1.1 + Math.sin(time * 20) * 0.08;
        meshRef.current.scale.lerp(new THREE.Vector3(volumeScale, volumeScale, volumeScale), 0.2);
      } else if (isProcessing) {
        const thinkingScale = 1.0 + Math.sin(time * 30) * 0.02;
        meshRef.current.scale.lerp(new THREE.Vector3(thinkingScale, thinkingScale, thinkingScale), 0.1);
        meshRef.current.rotation.y += 0.05; // Spin faster when processing
      } else if (isListening) {
        const pulse = 1.05 + Math.sin(time * 3) * 0.03;
        meshRef.current.scale.lerp(new THREE.Vector3(pulse, pulse, pulse), 0.1);
      } else {
        meshRef.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.05);
      }
    }

    if (groupRef.current) {
       // Gentle floating rotation
       groupRef.current.rotation.z = Math.sin(time * 0.5) * 0.1;
       groupRef.current.rotation.x = Math.cos(time * 0.3) * 0.1;
    }
  });

  // Sophisticated colors: Deep indigo for talking, emerald for listening, gold/purple for processing
  const baseColor = isProcessing 
    ? "#a855f7" 
    : isSpeaking 
      ? "#6366f1" 
      : isListening 
        ? "#10b981" 
        : "#f8fafc";

  return (
    <group ref={groupRef}>
      <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
        <Sphere ref={meshRef} args={[1.5, 128, 128]}>
          <MeshDistortMaterial
            ref={materialRef}
            color={baseColor}
            attach="material"
            distort={0.3}
            speed={2}
            roughness={0.1}
            metalness={0.9}
            emissive={baseColor}
            emissiveIntensity={isSpeaking ? 0.6 : isProcessing ? 1.2 : 0.1}
          />
        </Sphere>
      </Float>
      
      {/* Secondary outer shell for depth */}
      <Sphere args={[1.6, 64, 64]}>
        <meshStandardMaterial 
          color={baseColor}
          transparent 
          opacity={0.05} 
          wireframe={isProcessing} 
        />
      </Sphere>
    </group>
  );
};

interface VoiceOrbProps {
  isSpeaking: boolean;
  isListening: boolean;
  isProcessing: boolean;
}

export const VoiceOrb: React.FC<VoiceOrbProps> = ({ isSpeaking, isListening, isProcessing }) => {
  return (
    <div className="relative w-full h-[320px] md:h-[480px] flex items-center justify-center pointer-events-none">
      {/* Layered Glows for Depth */}
      <div className={`absolute inset-0 transition-all duration-1000 blur-[140px] rounded-full opacity-20 scale-150 ${
        isProcessing ? 'bg-purple-500' : isSpeaking ? 'bg-indigo-600' : isListening ? 'bg-emerald-400' : 'bg-slate-200'
      }`} />
      
      <Canvas camera={{ position: [0, 0, 6], fov: 35 }} style={{ background: 'transparent' }} shadows>
        <ambientLight intensity={1} />
        <spotLight position={[15, 15, 15]} angle={0.3} penumbra={1} intensity={2} castShadow />
        <pointLight position={[-10, -10, -10]} intensity={1} color="#ffffff" />
        <Environment preset="night" />
        <OrbInner isSpeaking={isSpeaking} isListening={isListening} isProcessing={isProcessing} />
        <ContactShadows 
          position={[0, -2.5, 0]} 
          opacity={0.3} 
          scale={12} 
          blur={3} 
          far={5} 
        />
      </Canvas>

      {/* Aesthetic Orbitals for Processing */}
      {isProcessing && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="absolute w-[240px] h-[240px] border-[1px] border-purple-200/30 rounded-full animate-[spin_3s_linear_infinite]" />
          <div className="absolute w-[280px] h-[280px] border-[1px] border-indigo-200/20 rounded-full animate-[spin_5s_linear_infinite_reverse]" />
        </div>
      )}

      {/* Interactive Ripple Rings */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className={`absolute w-[220px] md:w-[380px] h-[220px] md:h-[380px] border-[0.5px] border-indigo-100/50 rounded-full transition-all duration-700 ${isSpeaking ? 'scale-110 opacity-100' : 'scale-100 opacity-0'}`} />
        <div className={`absolute w-[280px] md:w-[440px] h-[280px] md:h-[440px] border-[0.5px] border-indigo-50/30 rounded-full transition-all duration-1000 delay-100 ${isSpeaking ? 'scale-125 opacity-100' : 'scale-100 opacity-0'}`} />
      </div>
    </div>
  );
};
